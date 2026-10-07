/**
 * Mail controls from the CRM: archive/delete/put-back mirrored into the mailbox by the worker,
 * and sending with Cc + job-document attachments.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import * as s from "@/db/schema";
import { locateMessage, runMailboxOps } from "@/worker/mail-ops";
import { approve, createDraft, sendApproved } from "@/lib/comms/outbound";
import type { OutgoingMail } from "@/lib/integrations/titan-mail";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

type Msg = { uid: number; messageId: string; date: Date };
type Folder = { path: string; specialUse?: string; flags?: string[]; messages: Msg[] };

/** Just enough of ImapFlow for the worker: folders with envelopes, search by date, move, create. */
function fakeImap(folders: Folder[]) {
  let current = "INBOX";
  const moves: { from: string; uid: number; to: string }[] = [];
  const f = (p: string) => folders.find((x) => x.path === p)!;
  const client = {
    list: async () => folders.map((x) => ({ path: x.path, specialUse: x.specialUse, flags: new Set(x.flags ?? []) })),
    getMailboxLock: async (path: string) => {
      current = path;
      return { release() {} };
    },
    mailboxOpen: async (path: string) => void (current = path),
    mailboxCreate: async (path: string) => void folders.push({ path, messages: [] }),
    search: async (q: { since: Date; before: Date }) => f(current).messages.filter((m) => m.date >= q.since && m.date < q.before).map((m) => m.uid),
    fetchAll: async (uids: number[]) => f(current).messages.filter((m) => uids.includes(m.uid)).map((m) => ({ uid: m.uid, envelope: { messageId: m.messageId } })),
    messageMove: async (uid: string, to: string) => {
      const src = f(current);
      const i = src.messages.findIndex((m) => m.uid === Number(uid));
      if (i < 0) throw new Error("no such uid");
      const [m] = src.messages.splice(i, 1);
      f(to).messages.push({ ...m, uid: m.uid + 1000 });
      moves.push({ from: src.path, uid: m.uid, to });
      return true;
    },
  };
  return { client: client as unknown as ImapFlow, moves, folders, opened: () => current };
}

const mid = () => `<${randomUUID()}@titan.test>`;

describe("locateMessage", () => {
  it("looks in INBOX first, then the other folders, within a day and a half of the message's date", async () => {
    const when = new Date("2026-10-05T15:00:00Z");
    const a = mid();
    const b = mid();
    const { client } = fakeImap([
      { path: "Sent", specialUse: "\\Sent", messages: [{ uid: 7, messageId: b, date: when }] },
      { path: "INBOX", messages: [{ uid: 3, messageId: a, date: when }, { uid: 4, messageId: mid(), date: new Date("2026-09-01T00:00:00Z") }] },
      { path: "Drafts", specialUse: "\\Drafts", messages: [{ uid: 1, messageId: a, date: when }] },
    ]);
    expect(await locateMessage(client, a, when)).toEqual({ folder: "INBOX", uid: 3 });
    expect(await locateMessage(client, b, when)).toEqual({ folder: "Sent", uid: 7 });
    expect(await locateMessage(client, a, new Date("2026-10-20T00:00:00Z"))).toBeNull();
  });
});

describe.skipIf(!hasTestDb)("mailbox ops + sending", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  const activity = async (messageId: string, pending: "archive" | "trash" | "inbox", when: Date) => {
    const [a] = await t.db
      .insert(s.activities)
      .values({ type: "EMAIL_IN", direction: "INBOUND", externalId: messageId, subject: "x", body: "y", occurredAt: when, raw: { mailboxPending: { action: pending, at: new Date().toISOString() }, keep: 1 } })
      .returning();
    return a;
  };
  const rawOf = async (id: string) => (await t.db.select({ raw: s.activities.raw }).from(s.activities).where(eq(s.activities.id, id)))[0].raw as Record<string, unknown>;

  it("moves pending messages to Archive (creating it), Trash and back to INBOX, and records the outcome", async () => {
    const when = new Date();
    const arch = mid();
    const del = mid();
    const back = mid();
    const gone = mid();
    const { client, moves, folders, opened } = fakeImap([
      { path: "INBOX", messages: [{ uid: 1, messageId: arch, date: when }, { uid: 2, messageId: del, date: when }] },
      { path: "Trash", specialUse: "\\Trash", messages: [{ uid: 9, messageId: back, date: when }] },
    ]);
    const a1 = await activity(arch, "archive", when);
    const a2 = await activity(del, "trash", when);
    const a3 = await activity(back, "inbox", when);
    const a4 = await activity(gone, "archive", when);
    const log: string[] = [];
    expect(await runMailboxOps(client, t.db, (...x) => log.push(x.join(" ")))).toBeGreaterThanOrEqual(4);
    expect(moves).toEqual(expect.arrayContaining([
      { from: "INBOX", uid: 1, to: "Archive" },
      { from: "INBOX", uid: 2, to: "Trash" },
      { from: "Trash", uid: 9, to: "INBOX" },
    ]));
    expect(folders.find((f) => f.path === "Archive")?.messages.map((m) => m.messageId)).toEqual([arch]);
    expect(await rawOf(a1.id)).toMatchObject({ keep: 1, mailbox: { action: "archive", folder: "Archive" } });
    expect(await rawOf(a2.id)).toMatchObject({ mailbox: { action: "trash", folder: "Trash" } });
    expect(await rawOf(a3.id)).toMatchObject({ mailbox: { action: "inbox", folder: "INBOX" } });
    const r4 = await rawOf(a4.id);
    expect(r4.mailboxPending).toBeUndefined();
    expect((r4.mailbox as { error: string }).error).toMatch(/Not found/);
    expect(log.join("\n")).toContain("archive failed");
    expect(opened()).toBe("INBOX");
    // Nothing left pending: a second run does nothing.
    expect(await runMailboxOps(client, t.db, () => {})).toBe(0);
  });

  it("sends with Cc and job-document attachments, and refuses a pricing document unless the message is marked as pricing", async () => {
    const [job] = await t.db.insert(s.jobs).values({ title: "Attach test", serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "QUALIFIED" }).returning();
    const [doc] = await t.db.insert(s.documents).values({ jobId: job.id, kind: "REPORT", title: "Report", storageBucket: "documents", storagePath: `${job.id}/report.pdf` }).returning();
    const [price] = await t.db.insert(s.documents).values({ jobId: job.id, kind: "PROPOSAL", title: "Proposal", storageBucket: "documents", storagePath: `${job.id}/proposal.pdf`, containsPricing: true }).returning();
    const sent: OutgoingMail[] = [];
    const deps = {
      quo: null,
      mail: { send: async (m: OutgoingMail) => (sent.push(m), { messageId: mid() }) },
      files: { download: async (_b: string, p: string) => Buffer.from(`bytes of ${p}`) },
    };
    const draft = await createDraft(t.db, {
      channel: "EMAIL",
      toAddress: "tenant@example.com",
      cc: ["pm@example.com"],
      subject: "Your report",
      body: "Attached.",
      jobId: job.id,
      fromEmail: "sales@ess-nyc.com",
      inReplyTo: "<q@example.com>",
      attachments: [{ documentId: doc.id, name: "Report.pdf" }],
    });
    await approve(t.db, draft.id, null);
    const row = await sendApproved(t.db, draft.id, deps);
    expect(row.status).toBe("SENT");
    expect(sent[0]).toMatchObject({ to: "tenant@example.com", cc: ["pm@example.com"], inReplyTo: "<q@example.com>" });
    expect(sent[0].attachments?.map((a) => [a.filename, a.content.toString()])).toEqual([["Report.pdf", `bytes of ${job.id}/report.pdf`]]);

    const d2 = await createDraft(t.db, { channel: "EMAIL", toAddress: "tenant@example.com", subject: "Price", body: "See attached.", jobId: job.id, attachments: [{ documentId: price.id, name: "Proposal.pdf" }] });
    await approve(t.db, d2.id, null);
    const failed = await sendApproved(t.db, d2.id, deps);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/contains ESS pricing/);
    expect(sent).toHaveLength(1);

    const d3 = await createDraft(t.db, { channel: "EMAIL", toAddress: "tenant@example.com", subject: "Price", body: "See attached.", jobId: job.id, containsPricing: true, attachments: [{ documentId: price.id, name: "Proposal.pdf" }] });
    await approve(t.db, d3.id, null);
    expect((await sendApproved(t.db, d3.id, deps)).status).toBe("SENT");
    expect(sent[1].attachments?.[0].filename).toBe("Proposal.pdf");
  });
});
