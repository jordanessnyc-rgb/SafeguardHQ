/**
 * Automation part 3 triggers: a client message, before a scheduled inspection, invoice paid, and a
 * compliance cycle coming due. Needs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { definitionSchema } from "@/lib/automation/definition";
import { enrolWorkflowEvents, runAutomations } from "@/lib/automation/engine";
import { nyDate } from "@/lib/time";
import { createUser, hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!hasTestDb)("workflow triggers (part 3)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
    await createUser(t, "OWNER");
  });
  afterAll(async () => t?.close());

  /** A workflow switched on now whose only step is a task, so business hours don't matter. */
  const workflow = async (trigger: unknown, steps: unknown[] = [{ type: "CREATE_TASK", title: "Follow up {{job_number}}" }]) => {
    const d = definitionSchema.parse({ trigger, steps });
    const [w] = await t.db.insert(s.workflows).values({ name: "test", active: true, activatedAt: new Date(), trigger: d.trigger, conditions: d.conditions, steps: d.steps }).returning();
    return w;
  };
  const off = (id: string) => t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, id));
  const runs = (workflowId: string) => t.db.select().from(s.workflowRuns).where(eq(s.workflowRuns.workflowId, workflowId));
  const job = async (j: Partial<typeof s.jobs.$inferInsert> = {}) => {
    const [c] = await t.db.insert(s.contacts).values({ firstName: "Dana", emails: ["dana@example.com"] }).returning();
    const [row] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD", clientContactId: c.id, ...j }).returning();
    return { job: row, contact: c };
  };

  it("a client message starts a run (by channel), but not AIRnyc, sealed, spam or unknown senders", async () => {
    const w = await workflow({ type: "MESSAGE_RECEIVED", channel: "SMS" }, [{ type: "STOP_IF_REPLIED" }, { type: "CREATE_TASK", title: "Reply to {{first_name}}" }]);
    const { contact, job: j } = await job();
    const at = new Date();
    const msg = (v: Partial<typeof s.activities.$inferInsert>) => t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", contactId: contact.id, jobId: j.id, body: "hi", occurredAt: at, ...v }).returning();
    const [good] = await msg({});
    await msg({ type: "EMAIL_IN" }); // wrong channel
    await msg({ sensitive: true });
    await msg({ triageCategory: "SPAM" });
    await msg({ contactId: null });
    const [airCase] = await t.db.insert(s.airnycCases).values({ caseId: `PHS_${Date.now() % 10000}`, network: "PHS" }).returning();
    await msg({ airnycCaseId: airCase.id });

    await runAutomations(t.db, null, new Date(Date.now() + 60_000));
    const r = await runs(w.id);
    expect(r.map((x) => x.triggerKey)).toEqual([good.id]);
    // The message that started it doesn't count as "the client replied".
    expect(r[0].status).toBe("DONE");
    await off(w.id);
  });

  it("before a scheduled inspection: fires once the reminder time comes, again only if rescheduled", async () => {
    const w = await workflow({ type: "BEFORE_SCHEDULED", amount: 1, unit: "days" });
    const base = new Date(Date.now() + 60_000);
    const { job: j } = await job({ stage: "SCHEDULED", scheduledAt: new Date(base.getTime() + 30 * HOUR) });

    expect(await enrolWorkflowEvents(t.db, base)).toBe(0); // reminder is at +6h
    expect(await enrolWorkflowEvents(t.db, new Date(base.getTime() + 7 * HOUR))).toBe(1);
    expect(await enrolWorkflowEvents(t.db, new Date(base.getTime() + 8 * HOUR))).toBe(0); // same appointment

    await t.db.update(s.jobs).set({ scheduledAt: new Date(base.getTime() + 60 * HOUR) }).where(eq(s.jobs.id, j.id));
    expect(await enrolWorkflowEvents(t.db, new Date(base.getTime() + 37 * HOUR))).toBe(1); // new time → new reminder
    expect(await runs(w.id)).toHaveLength(2);
    await off(w.id);
  });

  it("before a scheduled inspection: an inspection already inside the window when switched on still gets its reminder", async () => {
    const { job: j } = await job({ stage: "SCHEDULED", scheduledAt: new Date(Date.now() + 5 * HOUR) });
    const w = await workflow({ type: "BEFORE_SCHEDULED", amount: 2, unit: "days" });
    await enrolWorkflowEvents(t.db, new Date(Date.now() + 60_000));
    expect((await runs(w.id)).map((r) => r.jobId)).toEqual([j.id]);
    await off(w.id);
  });

  it("invoice paid starts a run for that job", async () => {
    const w = await workflow({ type: "INVOICE_PAID" });
    const { job: j } = await job({ stage: "INVOICED" });
    const { job: unpaid } = await job({ stage: "INVOICED" });
    await t.db.insert(s.jobFinancials).values([{ jobId: j.id, quotedAmount: "650.00", paidAt: new Date() }, { jobId: unpaid.id, quotedAmount: "650.00" }]);
    await runAutomations(t.db, null, new Date(Date.now() + 60_000));
    const r = await runs(w.id);
    expect(r.map((x) => [x.jobId, x.status])).toEqual([[j.id, "DONE"]]);
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, j.id));
    expect(tasks.map((x) => x.title)).toEqual([`Follow up ${j.jobNumber}`]);
    expect(tasks[0].title).not.toContain("650"); // no amounts in the task
    await off(w.id);
  });

  it("compliance due: cycles due within the window start runs; past-due and far-off ones don't", async () => {
    const now = new Date(Date.now() + 60_000);
    const due = (days: number) => nyDate(new Date(now.getTime() + days * DAY));
    const w = await workflow({ type: "COMPLIANCE_DUE", daysBefore: 30 });
    const soon = await job({ stage: "CLOSED", nextCycleDue: due(10) });
    await job({ stage: "CLOSED", nextCycleDue: due(90) });
    await job({ stage: "CLOSED", nextCycleDue: due(-3) });
    await enrolWorkflowEvents(t.db, now);
    expect((await runs(w.id)).map((r) => r.jobId)).toEqual([soon.job.id]);
    expect(await enrolWorkflowEvents(t.db, now)).toBe(0);
    await off(w.id);
  });
});
