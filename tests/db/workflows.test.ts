/**
 * Workflow engine (automation part 2): enrolment (only after switch-on, never twice, loop guard),
 * conditions, steps (wait, email/text drafts — never sent, tasks, tags, stage moves, stop if replied),
 * and the safety rules (AIRnyc, do-not-contact). Needs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { definitionSchema, type Definition } from "@/lib/automation/definition";
import { advanceWorkflowRuns, enrolWorkflowEvents, runAutomations } from "@/lib/automation/engine";
import { findOrCreateTag, addTag } from "@/lib/tags";
import { createUser, hasTestDb, pgError, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

// Tuesday 10:00 AM New York — inside default business hours.
const NOW = new Date("2026-09-29T14:00:00Z");
const HOUR = 3_600_000;

describe("workflow definitions (no database)", () => {
  it("accepts a valid workflow and fills defaults", () => {
    const d = definitionSchema.parse({ trigger: { type: "TAG_ADDED", tagId: "8f14e45f-ceea-467a-9575-6b1a8c3f9a01" }, steps: [{ type: "CREATE_TASK", title: "Call {{first_name}}" }] });
    expect(d.trigger).toMatchObject({ entity: "any" });
    expect(d.conditions).toEqual([]);
    expect(d.steps[0]).toMatchObject({ dueInDays: 1 });
  });

  it("rejects a workflow with no steps, an unknown step or a too-long wait", () => {
    expect(definitionSchema.safeParse({ trigger: { type: "CONTACT_CREATED" }, steps: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "CONTACT_CREATED" }, steps: [{ type: "DELETE_EVERYTHING" }] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger: { type: "CONTACT_CREATED" }, steps: [{ type: "WAIT", amount: 400, unit: "days" }] }).success).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("workflow engine", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    await t.db.insert(s.phoneLines).values({ label: "ESS main", lineKey: "ESS_MAIN", number: "+19293051232", quoPhoneNumberId: "PN1", brand: "ESS" });
  });
  afterAll(async () => t?.close());

  /** A workflow switched on just now (only events from now on count). */
  const workflow = async (name: string, def: unknown, extra: Partial<typeof s.workflows.$inferInsert> = {}) => {
    const d: Definition = definitionSchema.parse(def);
    const [w] = await t.db
      .insert(s.workflows)
      .values({ name, active: true, activatedAt: new Date(), trigger: d.trigger, conditions: d.conditions, steps: d.steps, ...extra })
      .returning();
    return w;
  };
  const job = async (contact: Partial<typeof s.contacts.$inferInsert> = {}, j: Partial<typeof s.jobs.$inferInsert> = {}) => {
    const [c] = await t.db.insert(s.contacts).values({ firstName: "Dana", lastName: "Reyes", emails: ["dana@example.com"], phones: ["+19295550100"], ...contact }).returning();
    const [p] = await t.db.insert(s.properties).values({ addressLine: "47-58 43 STREET", unit: "3B" }).returning();
    const [row] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD", clientContactId: c.id, propertyId: p.id, ...j }).returning();
    return { job: row, contact: c };
  };
  const moveTo = (jobId: string, stage: string) => t.db.update(s.jobs).set({ stage }).where(eq(s.jobs.id, jobId));
  const runs = (workflowId: string) => t.db.select().from(s.workflowRuns).where(eq(s.workflowRuns.workflowId, workflowId));
  const outbox = (jobId: string) => t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.jobId, jobId));

  it("ignores events from before the workflow was switched on", async () => {
    const before = await job();
    await moveTo(before.job.id, "QUALIFIED");
    const w = await workflow("Qualified → task", { trigger: { type: "JOB_STAGE_ENTERED", stage: "QUALIFIED" }, steps: [{ type: "CREATE_TASK", title: "Send proposal to {{first_name}}" }] }, { activatedAt: new Date(Date.now() + 60_000) });
    await enrolWorkflowEvents(t.db, NOW);
    expect(await runs(w.id)).toHaveLength(0);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("job enters a stage → email drafted for approval, wait, task; never enrolled twice", async () => {
    const w = await workflow("Scheduled → confirm", {
      trigger: { type: "JOB_STAGE_ENTERED", stage: "SCHEDULED" },
      steps: [
        { type: "SEND_EMAIL", subject: "Your inspection at {{address}}", body: "Hi {{first_name}}, see you soon. — {{brand_name}}" },
        { type: "WAIT", amount: 2, unit: "days" },
        { type: "CREATE_TASK", title: "Check {{job_number}} went ahead" },
      ],
    });
    const { job: j } = await job();
    await moveTo(j.id, "SCHEDULED");

    expect(await runAutomations(t.db, NOW)).toMatchObject({ started: 1, advanced: 1 });
    expect(await enrolWorkflowEvents(t.db, NOW)).toBe(0); // same event: no second run

    const [draft] = await outbox(j.id);
    expect(draft).toMatchObject({ status: "DRAFT", channel: "EMAIL", toAddress: "dana@example.com", subject: "Your inspection at 47-58 43 STREET Apt 3B", source: "SYSTEM" });
    expect(draft.body).toContain("Hi Dana");
    let [run] = await runs(w.id);
    expect(run).toMatchObject({ status: "WAITING", stepIndex: 2 });
    expect(run.resumeAt.getTime()).toBe(NOW.getTime() + 48 * HOUR);

    // Not due yet → nothing happens; after two days the task is created and the run finishes.
    await advanceWorkflowRuns(t.db, new Date(NOW.getTime() + HOUR));
    expect((await runs(w.id))[0].status).toBe("WAITING");
    await advanceWorkflowRuns(t.db, new Date(NOW.getTime() + 49 * HOUR));
    [run] = await runs(w.id);
    expect(run.status).toBe("DONE");
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, j.id));
    expect(tasks.map((x) => x.title)).toEqual([`Check ${j.jobNumber} went ahead`]);
    expect(tasks[0].assignee).toBe(owner.id);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("never sends: emails are Outbox drafts at any hour, with blank fields marked for whoever approves", async () => {
    const w = await workflow("Lab pending → update", { trigger: { type: "JOB_STAGE_ENTERED", stage: "LAB_PENDING" }, steps: [{ type: "SEND_EMAIL", subject: "Samples are at the lab", body: "Hi {{first_name}}, we'll see you again on {{scheduled_date}}." }] });
    const { job: j } = await job({ emails: ["lab@example.com"] });
    await t.db.insert(s.samples).values({ jobId: j.id, sampleId: "S-1", type: "AIR", status: "SUBMITTED" });
    await moveTo(j.id, "LAB_PENDING");

    const night = new Date("2026-09-30T03:00:00Z"); // 11 PM New York: drafting doesn't wait for business hours
    await runAutomations(t.db, night);
    const [msg] = await outbox(j.id);
    expect(msg).toMatchObject({ status: "DRAFT", toAddress: "lab@example.com", subject: "Samples are at the lab", approvedAt: null });
    expect(msg.body).toContain("[scheduled date]");
    const [run] = await runs(w.id);
    expect(run.status).toBe("DONE");
    expect(run.log.map((l) => l.note).join(" ")).toMatch(/drafted in the Outbox for someone to approve\. Fill in scheduled date/);
    const sentAnything = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.status, "SENT"));
    expect(sentAnything).toHaveLength(0);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("conditions skip a run and say why", async () => {
    const vip = await findOrCreateTag(t.db, "VIP");
    const w = await workflow("VIP only", { trigger: { type: "JOB_CREATED" }, conditions: [{ type: "HAS_TAG", tagId: vip.id }, { type: "SERVICE_IS", values: ["LL152"] }], steps: [{ type: "NOTIFY_OWNER", message: "VIP job {{job_number}}" }] });
    const plain = await job();
    const tagged = await job();
    await addTag(t.db, "contact", tagged.contact.id, vip.id);
    await runAutomations(t.db, NOW);
    const byJob = new Map((await runs(w.id)).map((r) => [r.jobId, r]));
    expect(byJob.get(plain.job.id)?.status).toBe("SKIPPED");
    expect(byJob.get(plain.job.id)?.log[0].note).toMatch(/required tag/);
    expect(byJob.get(tagged.job.id)?.status).toBe("DONE");
    const notes = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, tagged.job.id));
    expect(notes[0].title).toBe(`VIP job ${tagged.job.jobNumber}`);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("tag added → add a tag, move the stage, and a stage rule refusing a move is logged, not fatal", async () => {
    const hot = await findOrCreateTag(t.db, "Hot lead", "red");
    const called = await findOrCreateTag(t.db, "Called");
    const w = await workflow("Hot lead", {
      trigger: { type: "TAG_ADDED", tagId: hot.id, entity: "job" },
      steps: [
        { type: "MOVE_STAGE", stage: "QUALIFIED" },
        { type: "MOVE_STAGE", stage: "DELIVERED" }, // needs a FINAL report → refused
        { type: "ADD_TAG", tagId: called.id, target: "contact" },
      ],
    });
    const { job: j, contact } = await job();
    await addTag(t.db, "job", j.id, hot.id);
    await runAutomations(t.db, NOW);
    const [run] = await runs(w.id);
    expect(run.status).toBe("DONE");
    expect(run.log.map((l) => l.outcome)).toEqual(["ok", "failed", "ok", "ok"]);
    const [after] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, j.id));
    expect(after.stage).toBe("QUALIFIED");
    const links = await t.db.select().from(s.contactTags).where(and(eq(s.contactTags.contactId, contact.id), eq(s.contactTags.tagId, called.id)));
    expect(links).toHaveLength(1);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("stops when the client replied, and never messages do-not-contact people", async () => {
    const w = await workflow("Nudge", { trigger: { type: "CONTACT_CREATED" }, steps: [{ type: "WAIT", amount: 1, unit: "days" }, { type: "STOP_IF_REPLIED" }, { type: "SEND_SMS", body: "Hi {{first_name}}, still interested?" }] });
    const [replied] = await t.db.insert(s.contacts).values({ firstName: "Ana", phones: ["+19295550111"] }).returning();
    const [dnc] = await t.db.insert(s.contacts).values({ firstName: "Bo", phones: ["+19295550112"], doNotContact: true }).returning();
    const [quiet] = await t.db.insert(s.contacts).values({ firstName: "Cy", phones: ["+19295550113"] }).returning();
    await runAutomations(t.db, NOW);
    await t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", contactId: replied.id, body: "Yes please", occurredAt: new Date(Date.now() + 1000) });
    await runAutomations(t.db, new Date(NOW.getTime() + 25 * HOUR));

    const byContact = new Map((await runs(w.id)).map((r) => [r.contactId, r]));
    expect(byContact.get(replied.id)?.status).toBe("STOPPED");
    expect(byContact.get(dnc.id)?.log.at(-2)?.note).toMatch(/do-not-contact/);
    expect(byContact.get(quiet.id)?.status).toBe("DONE");
    const texts = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.channel, "SMS"));
    expect(texts.map((m) => m.toAddress)).toEqual(["+19295550113"]);
    expect(texts[0]).toMatchObject({ status: "DRAFT", body: "Hi Cy, still interested?" });
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("never touches AIRnyc jobs", async () => {
    const w = await workflow("All new jobs", { trigger: { type: "JOB_CREATED" }, steps: [{ type: "SEND_EMAIL", subject: "Hi", body: "Hello" }] });
    const { job: j } = await job({}, { serviceCode: "AIRNYC", pipelineKey: "AIRNYC", stage: "REFERRAL_RECEIVED" });
    await runAutomations(t.db, NOW);
    const run = (await runs(w.id)).find((r) => r.jobId === j.id);
    expect(run?.status).toBe("SKIPPED");
    expect(run?.log[0].note).toMatch(/AIRnyc/);
    expect(await outbox(j.id)).toHaveLength(0);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("runs at most once per record per day, so workflows can't loop", async () => {
    const w = await workflow("Ping-pong", { trigger: { type: "JOB_STAGE_ENTERED", stage: "QUALIFIED" }, steps: [{ type: "MOVE_STAGE", stage: "LEAD" }] });
    const { job: j } = await job();
    await moveTo(j.id, "QUALIFIED");
    await runAutomations(t.db, NOW); // moves it back to LEAD
    await moveTo(j.id, "QUALIFIED");
    await runAutomations(t.db, NOW);
    const statuses = (await runs(w.id)).map((r) => r.status).sort();
    expect(statuses).toEqual(["DONE", "SKIPPED"]);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
  });

  it("switching a workflow off stops its waiting runs", async () => {
    const w = await workflow("Long wait", { trigger: { type: "CONTACT_CREATED" }, steps: [{ type: "WAIT", amount: 1, unit: "hours" }, { type: "NOTIFY_OWNER", message: "Hello" }] });
    await t.db.insert(s.contacts).values({ firstName: "Di" });
    await runAutomations(t.db, NOW);
    await t.db.update(s.workflows).set({ active: false }).where(eq(s.workflows.id, w.id));
    await advanceWorkflowRuns(t.db, new Date(NOW.getTime() + 2 * HOUR));
    expect((await runs(w.id)).every((r) => r.status === "STOPPED")).toBe(true);
  });

  it("a VA can read workflows but not create or change them", async () => {
    const seen = await va.as((tx) => tx.select({ id: s.workflows.id }).from(s.workflows));
    expect(seen.length).toBeGreaterThan(0);
    const msg = await pgError(va.as((tx) => tx.insert(s.workflows).values({ name: "Sneaky", trigger: { type: "CONTACT_CREATED" } })));
    expect(msg).toMatch(/row-level security/);
    const upd = await va.as((tx) => tx.update(s.workflows).set({ name: "Changed by a VA" }).returning());
    expect(upd).toHaveLength(0);
  });
});
