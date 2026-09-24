/** Worker mail loop pieces: UIDVALIDITY/last-UID tracking and the 15-minute health alert. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer";
import type { ImapFlow } from "imapflow";
import * as s from "@/db/schema";
import { loadState, processNew } from "@/worker/mail";
import { mailHealthCheck } from "@/worker/health";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const cfg = { user: "crm@ess-nyc.com", password: "x", imapHost: "h", imapPort: 993, smtpHost: "h", smtpPort: 465, smtpSecure: true, sentFolder: "Sent", appendToSent: false, allowSelfSigned: false };
const mail = (n: number) =>
  new MailComposer({ from: `p${n}@example.com`, to: cfg.user, subject: `hello ${n}`, text: "hi", messageId: `<w${n}@test>` }).compile().build();

function fakeImap(uidValidity: bigint, uidNext: number, messages: { uid: number; source: Buffer }[]) {
  return {
    mailbox: { uidValidity, uidNext },
    getMailboxLock: vi.fn(async () => ({ release: () => undefined })),
    fetchAll: vi.fn(async (range: string) => {
      const from = Number(range.split(":")[0]);
      const hits = messages.filter((m) => m.uid >= from);
      // IMAP "N:*" returns the last message even when N > max UID.
      return hits.length ? hits : messages.slice(-1);
    }),
  } as unknown as ImapFlow;
}

describe.skipIf(!hasTestDb)("worker mail loop", () => {
  let t: TestDb;
  const deps = () => ({ db: t.db, cfg, storage: { upload: async () => undefined }, drive: null });
  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  it("first connect starts from 'now' instead of importing the whole inbox", async () => {
    const n = await processNew(fakeImap(BigInt(7), 101, [{ uid: 100, source: await mail(100) }]), deps());
    expect(n).toBe(0);
    expect(await loadState(t.db, cfg.user)).toMatchObject({ uidValidity: "7", lastUid: 100 });
  });

  it("imports only messages after the last UID, once", async () => {
    const msgs = [
      { uid: 100, source: await mail(100) },
      { uid: 101, source: await mail(101) },
      { uid: 102, source: await mail(102) },
    ];
    expect(await processNew(fakeImap(BigInt(7), 103, msgs), deps())).toBe(2);
    expect(await processNew(fakeImap(BigInt(7), 103, msgs), deps())).toBe(0); // "*" returns uid 102 again → filtered
    expect((await loadState(t.db, cfg.user))?.lastUid).toBe(102);
    const acts = await t.db.select().from(s.activities);
    expect(acts.map((a) => a.externalId).sort()).toEqual(["<w101@test>", "<w102@test>"]);
  });

  it("a UIDVALIDITY change resets the cursor without re-importing", async () => {
    expect(await processNew(fakeImap(BigInt(8), 5, [{ uid: 4, source: await mail(101) }]), deps())).toBe(0);
    expect(await loadState(t.db, cfg.user)).toMatchObject({ uidValidity: "8", lastUid: 4 });
  });

  it("health: alerts Jordan by SMS after 15 min without a sync, then suppresses for an hour", async () => {
    const [line] = await t.db.insert(s.phoneLines).values({ quoPhoneNumberId: "PN1", number: "+19293051232", label: "ESS", lineKey: "ESS_MAIN" }).returning();
    await t.db.update(s.settings).set({ healthAlertPhone: "+19175550000", healthAlertLineId: line.id });
    const sendSms = vi.fn(async () => ({ id: "AC1" }));
    const quo = { sendSms } as never;
    const now = new Date();
    expect(await mailHealthCheck(t.db, cfg.user, quo, now)).toBe("ok"); // just synced above

    await t.db.update(s.mailSyncState).set({ lastOkAt: new Date(now.getTime() - 20 * 60_000) }).where(eq(s.mailSyncState.mailbox, cfg.user));
    expect(await mailHealthCheck(t.db, cfg.user, quo, now)).toBe("alerted");
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ from: "PN1", to: "+19175550000" }));
    expect(await mailHealthCheck(t.db, cfg.user, quo, new Date(now.getTime() + 10 * 60_000))).toBe("suppressed");
    expect(await mailHealthCheck(t.db, cfg.user, quo, new Date(now.getTime() + 61 * 60_000))).toBe("alerted");
  });

  it("health: no false alarm right after the worker starts (15-minute grace)", async () => {
    await t.db.update(s.mailSyncState).set({ lastOkAt: null, lastAlertAt: null, lastError: null });
    const sendSms = vi.fn(async () => ({ id: "AC0" }));
    const start = new Date();
    expect(await mailHealthCheck(t.db, cfg.user, { sendSms } as never, new Date(start.getTime() + 60_000), start)).toBe("ok");
    expect(await mailHealthCheck(t.db, cfg.user, { sendSms } as never, new Date(start.getTime() + 16 * 60_000), start)).toBe("alerted");
  });

  it("an empty poll still refreshes lastOkAt (keeps the health check quiet on slow days)", async () => {
    await t.db.update(s.mailSyncState).set({ lastOkAt: new Date(Date.now() - 3600_000) });
    const st = await loadState(t.db, cfg.user);
    await processNew(fakeImap(BigInt(Number(st!.uidValidity)), st!.lastUid + 1, []), deps());
    expect((await loadState(t.db, cfg.user))!.lastOkAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it("health: an IMAP auth failure alerts even if the last sync was recent", async () => {
    await t.db.update(s.mailSyncState).set({ lastOkAt: new Date(), lastAlertAt: null, lastError: "IMAP authentication failed" });
    const sendSms = vi.fn(async () => ({ id: "AC2" }));
    expect(await mailHealthCheck(t.db, cfg.user, { sendSms } as never)).toBe("alerted");
  });
});
