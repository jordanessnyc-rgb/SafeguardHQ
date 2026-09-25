/** Dashboard "Needs you" list: what shows up, in what order, and that a VA never gets money rows. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { buildNeedsYou } from "@/lib/dashboard/needs-you";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

const now = new Date("2026-09-25T15:00:00Z"); // 11:00 New York
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe.skipIf(!hasTestDb)("needs-you list (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");

    const [stale] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "LEAD" }).returning();
    // Stage entry time is set by trigger on insert; backdate it directly (Lead's limit is 2 days).
    await t.pool.query("update public.jobs set stage_entered_at = $1 where id = $2", [daysAgo(6), stale.id]);
    await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD" }); // fresh, not stale

    await t.db.insert(s.outboundMessages).values([
      { channel: "SMS", toAddress: "+17185550100", body: "Confirmed for Tuesday.", createdAt: new Date(now.getTime() - 2 * 3600_000) },
      { channel: "EMAIL", toAddress: "a@example.test", body: "Hello", status: "FAILED" },
      { channel: "SMS", toAddress: "+17185550101", body: "Sent already", status: "SENT" },
    ]);
    await t.db.insert(s.activities).values([
      { type: "SMS", direction: "INBOUND", fromAddress: "+17185550102", body: "?", occurredAt: daysAgo(0), triageStatus: "NEEDS_REVIEW" },
      { type: "EMAIL_IN", direction: "INBOUND", fromAddress: "x@example.test", body: "case", occurredAt: daysAgo(0), triageStatus: "BLOCKED" },
      { type: "SMS", direction: "INBOUND", fromAddress: "+17185550103", body: "ok", occurredAt: daysAgo(0), triageStatus: "AUTO" },
    ]);
    await t.db.insert(s.tasks).values([
      { title: "Overdue, unassigned", dueAt: daysAgo(3) },
      { title: "Due later today, mine", dueAt: new Date("2026-09-25T21:00:00Z"), assignee: va.id },
      { title: "Tomorrow", dueAt: new Date("2026-09-26T15:00:00Z") },
      { title: "Someone else's", dueAt: daysAgo(1), assignee: owner.id },
      { title: "Done already", dueAt: daysAgo(1), status: "DONE" },
    ]);
    await t.db.insert(s.invoicesCache).values({ freshbooksInvoiceId: "fb-1", invoiceNumber: "0042", outstanding: "900.00", status: "sent", issuedAt: "2026-07-01", dueAt: "2026-07-31" });
  });
  afterAll(async () => t?.close());

  it("lists the queues, due tasks and stale jobs, most urgent first", async () => {
    const items = await va.as((tx) => buildNeedsYou(tx, { userId: va.id, isOwner: false, now }));
    const keys = items.map((i) => i.key.split(":")[0]);

    const outbox = items.find((i) => i.key === "outbox")!;
    expect(outbox.title).toBe("2 messages waiting for your approval"); // SENT excluded
    expect(outbox.meta).toMatch(/1 failed/);
    const inbox = items.find((i) => i.key === "inbox")!;
    expect(inbox.title).toBe("2 messages to file"); // AUTO excluded
    expect(inbox.meta).toMatch(/1 AIRnyc/);

    const tasks = items.filter((i) => i.kind === "task").map((i) => i.title);
    expect(tasks).toEqual(["Overdue, unassigned", "Due later today, mine"]); // not tomorrow, not someone else's, not done
    expect(items.find((i) => i.title === "Overdue, unassigned")).toMatchObject({ late: true, when: "3 days overdue", taskId: expect.any(String) });
    expect(items.find((i) => i.title === "Due later today, mine")).toMatchObject({ late: false, when: "Due today" });

    const stale = items.filter((i) => i.kind === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0].meta).toMatch(/^Lead for 6 days \(limit 2\)/);
    expect(stale[0].when).toBe("4 days over");

    // A failed send outranks everything; overdue tasks come before the inbox.
    expect(keys[0]).toBe("outbox");
    expect(keys.indexOf("task")).toBeLessThan(keys.indexOf("inbox"));
  });

  it("shows overdue invoices to the owner only", async () => {
    const forVa = await va.as((tx) => buildNeedsYou(tx, { userId: va.id, isOwner: false, now }));
    expect(forVa.some((i) => i.kind === "invoice")).toBe(false);

    const forOwner = await owner.as((tx) => buildNeedsYou(tx, { userId: owner.id, isOwner: true, now }));
    expect(forOwner.find((i) => i.kind === "invoice")).toMatchObject({ title: "Invoice 0042 unpaid", when: "31-60 days" });
    // The owner doesn't see the VA's own task, but does see their own overdue one.
    expect(forOwner.filter((i) => i.kind === "task").map((i) => i.title)).toEqual(["Overdue, unassigned", "Someone else's"]);
  });
});
