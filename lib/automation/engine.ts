/**
 * Workflow engine (automation part 2). Run by the worker every minute with the privileged connection.
 *
 *  1. enrol:   for each active workflow, find events since it was switched on (a job entering a stage,
 *              a tag added, a new job or person) and start one run per event. `trigger_key` is unique
 *              per workflow, so an event never starts two runs, however often this is called.
 *  2. advance: for each run that is due, carry out its steps in order until a Wait (which sets
 *              `resume_at`) or the end. Each run is handled in its own transaction with the row locked
 *              (`skip locked`), so two workers can't both act on it and a crash rolls the step back.
 *
 * Safety rules, whatever a workflow says:
 *  - Workflows NEVER send anything. An email or text step only creates an Outbox draft, and a person
 *    approves and sends it (CLAUDE.md rule 6; there is deliberately no auto-send for workflows).
 *  - AIRnyc jobs are never touched (CLAUDE.md rule 5); do-not-contact people are never messaged.
 *  - A workflow runs at most once per record per 24 hours, so two workflows that trigger each other
 *    (A moves a job to X, B moves it back) can't loop.
 */
import { and, asc, eq, gt, gte, inArray, lte, or, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import type { WorkflowLogEntry } from "@/db/schema";
import { createDraft } from "@/lib/comms/outbound";
import { renderTemplate } from "@/lib/comms/templates";
import { templateVars } from "@/lib/comms/template-vars";
import { stageRuleMessage } from "@/lib/pipeline/rules";
import { addTag, removeTag } from "@/lib/tags";
import { definitionSchema, STEP_LABELS, waitMs, type Condition, type Definition, type Step, type Trigger } from "./definition";

type Workflow = typeof s.workflows.$inferSelect;
type Run = typeof s.workflowRuns.$inferSelect;
type LogEntry = WorkflowLogEntry;

const COOLDOWN_MS = 24 * 3_600_000;
const ENROL_BATCH = 200;
const ADVANCE_BATCH = 100;

export const WORKFLOW_TEMPLATE_PREFIX = "workflow:";

/** The definition stored on a workflow, re-validated (an invalid one is never run). */
export function workflowDefinition(w: Pick<Workflow, "trigger" | "conditions" | "steps">): Definition | null {
  const r = definitionSchema.safeParse({ trigger: w.trigger, conditions: w.conditions, steps: w.steps });
  return r.success ? r.data : null;
}

// =============================================================================================
// 1. Enrolment
// =============================================================================================

type Event = { key: string; at: Date; jobId: string | null; contactId: string | null; orgId: string | null };

async function newEvents(db: Db, w: Workflow, trigger: Trigger, now: Date): Promise<Event[]> {
  const since = w.activatedAt!;
  const seen = (key: ReturnType<typeof sql>) =>
    sql`not exists (select 1 from ${s.workflowRuns} r where r.workflow_id = ${w.id} and r.trigger_key = ${key})`;

  switch (trigger.type) {
    case "JOB_STAGE_ENTERED": {
      const rows = await db.execute<{ key: string; at: Date; job_id: string }>(sql`
        select a.id::text as key, a.occurred_at as at, a.job_id
        from ${s.activities} a join ${s.jobs} j on j.id = a.job_id
        where a.type = 'STAGE_CHANGE' and a.raw->>'to' = ${trigger.stage} and a.occurred_at >= ${since}
          ${trigger.pipelineKey ? sql`and j.pipeline_key = ${trigger.pipelineKey}` : sql``}
          and ${seen(sql`a.id::text`)}
        order by a.occurred_at limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: r.job_id, contactId: null, orgId: null }));
    }
    case "JOB_CREATED": {
      const rows = await db.execute<{ key: string; at: Date; id: string }>(sql`
        select 'job:' || j.id as key, j.created_at as at, j.id
        from ${s.jobs} j
        where j.created_at >= ${since} ${trigger.pipelineKey ? sql`and j.pipeline_key = ${trigger.pipelineKey}` : sql``}
          and ${seen(sql`'job:' || j.id`)}
        order by j.created_at limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: r.id, contactId: null, orgId: null }));
    }
    case "CONTACT_CREATED": {
      const rows = await db.execute<{ key: string; at: Date; id: string }>(sql`
        select 'contact:' || c.id as key, c.created_at as at, c.id
        from ${s.contacts} c
        where c.created_at >= ${since} and ${seen(sql`'contact:' || c.id`)}
        order by c.created_at limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: null, contactId: r.id, orgId: null }));
    }
    case "TAG_ADDED": {
      // Re-adding a tag after removing it is a new event: the key includes when the link was made.
      const links = [
        { entity: "contact", table: s.contactTags, col: "contact_id" },
        { entity: "organization", table: s.organizationTags, col: "org_id" },
        { entity: "job", table: s.jobTags, col: "job_id" },
      ].filter((l) => trigger.entity === "any" || trigger.entity === l.entity);
      const out: Event[] = [];
      for (const l of links) {
        const key = sql`${l.entity} || ':' || t.${sql.identifier(l.col)} || ':' || (extract(epoch from t.created_at) * 1000)::bigint`;
        const rows = await db.execute<{ key: string; at: Date; id: string }>(sql`
          select ${key} as key, t.created_at as at, t.${sql.identifier(l.col)} as id
          from ${l.table} t
          where t.tag_id = ${trigger.tagId} and t.created_at >= ${since} and ${seen(key)}
          order by t.created_at limit ${ENROL_BATCH}`);
        for (const r of rows.rows)
          out.push({ key: r.key, at: new Date(r.at), jobId: l.entity === "job" ? r.id : null, contactId: l.entity === "contact" ? r.id : null, orgId: l.entity === "organization" ? r.id : null });
      }
      return out;
    }
    case "MESSAGE_RECEIVED": {
      // Only messages from a known person; never AIRnyc-linked or sealed content (CLAUDE.md rule 5), never spam.
      const types = trigger.channel === "EMAIL" ? ["EMAIL_IN"] : trigger.channel === "SMS" ? ["SMS"] : trigger.channel === "CALL" ? ["CALL"] : ["EMAIL_IN", "SMS", "CALL"];
      const rows = await db.execute<{ key: string; at: Date; job_id: string | null; contact_id: string }>(sql`
        select a.id::text as key, a.occurred_at as at, a.job_id, a.contact_id
        from ${s.activities} a
        where a.direction = 'INBOUND' and a.type::text in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
          and a.contact_id is not null and a.airnyc_case_id is null and not a.sensitive
          and coalesce(a.triage_category, '') <> 'SPAM'
          and a.occurred_at >= ${since} and a.occurred_at <= ${now}
          and ${seen(sql`a.id::text`)}
        order by a.occurred_at limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: r.job_id, contactId: r.contact_id, orgId: null }));
    }
    case "BEFORE_SCHEDULED": {
      // Fires once the reminder moment (scheduled time minus the offset) has come, for inspections still
      // ahead. Unlike the other triggers this doesn't require the moment to be after switch-on: switching
      // on a "2 days before" reminder should still cover tomorrow's inspection. A rescheduled inspection
      // is a new event (the key carries the time).
      const hours = trigger.amount * (trigger.unit === "days" ? 24 : 1);
      const key = sql`'appt:' || j.id || ':' || (extract(epoch from j.scheduled_at) * 1000)::bigint`;
      const rows = await db.execute<{ key: string; at: Date; id: string }>(sql`
        select ${key} as key, j.scheduled_at - make_interval(hours => ${hours}) as at, j.id
        from ${s.jobs} j
        where j.scheduled_at is not null and j.archived_at is null and j.stage <> 'LOST'
          and j.scheduled_at > ${now}
          and j.scheduled_at - make_interval(hours => ${hours}) <= ${now}
          ${trigger.pipelineKey ? sql`and j.pipeline_key = ${trigger.pipelineKey}` : sql``}
          and ${seen(key)}
        order by j.scheduled_at limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: r.id, contactId: null, orgId: null }));
    }
    case "INVOICE_PAID": {
      const key = sql`'paid:' || f.job_id || ':' || (extract(epoch from f.paid_at) * 1000)::bigint`;
      const rows = await db.execute<{ key: string; at: Date; job_id: string }>(sql`
        select ${key} as key, f.paid_at as at, f.job_id
        from ${s.jobFinancials} f
        where f.paid_at >= ${since} and f.paid_at <= ${now} and ${seen(key)}
        order by f.paid_at limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: r.job_id, contactId: null, orgId: null }));
    }
    case "COMPLIANCE_DUE": {
      // next_cycle_due is a New York date; the event is midnight New York, `daysBefore` days earlier. Like
      // BEFORE_SCHEDULED, any cycle not yet due counts, even if the reminder moment was before switch-on.
      const at = sql`((j.next_cycle_due - ${trigger.daysBefore}::int)::timestamp at time zone 'America/New_York')`;
      const key = sql`'cycle:' || j.id || ':' || j.next_cycle_due::text`;
      const rows = await db.execute<{ key: string; at: Date; id: string }>(sql`
        select ${key} as key, ${at} as at, j.id
        from ${s.jobs} j
        where j.next_cycle_due is not null and j.archived_at is null
          and ${at} <= ${now}
          and j.next_cycle_due >= (${now}::timestamptz at time zone 'America/New_York')::date
          and ${seen(key)}
        order by j.next_cycle_due limit ${ENROL_BATCH}`);
      return rows.rows.map((r) => ({ key: r.key, at: new Date(r.at), jobId: r.id, contactId: null, orgId: null }));
    }
  }
}

/** Starts runs for new events. Returns how many runs were started (not counting skipped repeats). */
export async function enrolWorkflowEvents(db: Db, now = new Date()): Promise<number> {
  const active = await db.select().from(s.workflows).where(and(eq(s.workflows.active, true), sql`${s.workflows.archivedAt} is null`, sql`${s.workflows.activatedAt} is not null`));
  let started = 0;
  for (const w of active) {
    const def = workflowDefinition(w);
    if (!def) continue;
    for (const e of await newEvents(db, w, def.trigger, now)) {
      // Loop guard: one run per record per workflow per 24h. The event is still recorded (as skipped)
      // so it isn't picked up again later.
      const recent = await db
        .select({ id: s.workflowRuns.id })
        .from(s.workflowRuns)
        .where(
          and(
            eq(s.workflowRuns.workflowId, w.id),
            gte(s.workflowRuns.createdAt, new Date(now.getTime() - COOLDOWN_MS)),
            inArray(s.workflowRuns.status, ["RUNNING", "WAITING", "DONE", "STOPPED"]),
            e.jobId ? eq(s.workflowRuns.jobId, e.jobId) : e.contactId ? eq(s.workflowRuns.contactId, e.contactId) : eq(s.workflowRuns.orgId, e.orgId!),
          ),
        )
        .limit(1);
      const skip = recent.length > 0;
      const rows = await db
        .insert(s.workflowRuns)
        .values({
          workflowId: w.id,
          triggerKey: e.key,
          jobId: e.jobId,
          contactId: e.contactId,
          orgId: e.orgId,
          eventAt: e.at,
          createdAt: now, // same clock as the 24h loop guard above
          status: skip ? "SKIPPED" : "RUNNING",
          resumeAt: now,
          log: skip ? [entry(now, null, "skipped", "Already ran for this record in the last 24 hours.")] : [],
        })
        .onConflictDoNothing()
        .returning({ id: s.workflowRuns.id });
      if (rows.length && !skip) started++;
    }
  }
  return started;
}

// =============================================================================================
// 2. Advancing runs
// =============================================================================================

type Ctx = {
  job: typeof s.jobs.$inferSelect | null;
  contact: typeof s.contacts.$inferSelect | null;
  orgId: string | null;
  tagIds: Set<string>;
};

async function loadContext(tx: Tx, run: Run): Promise<Ctx> {
  const [job] = run.jobId ? await tx.select().from(s.jobs).where(eq(s.jobs.id, run.jobId)) : [];
  const contactId = run.contactId ?? job?.clientContactId ?? null;
  const [contact] = contactId ? await tx.select().from(s.contacts).where(eq(s.contacts.id, contactId)) : [];
  const orgId = run.orgId ?? job?.clientOrgId ?? contact?.orgId ?? null;
  const tagIds = new Set<string>();
  const add = (rows: { tagId: string }[]) => rows.forEach((r) => tagIds.add(r.tagId));
  if (job) add(await tx.select({ tagId: s.jobTags.tagId }).from(s.jobTags).where(eq(s.jobTags.jobId, job.id)));
  if (contact) add(await tx.select({ tagId: s.contactTags.tagId }).from(s.contactTags).where(eq(s.contactTags.contactId, contact.id)));
  if (orgId) add(await tx.select({ tagId: s.organizationTags.tagId }).from(s.organizationTags).where(eq(s.organizationTags.orgId, orgId)));
  return { job: job ?? null, contact: contact ?? null, orgId, tagIds };
}

/** Why a condition fails, or null when it holds. */
export function failedCondition(c: Condition, ctx: Pick<Ctx, "job" | "contact" | "tagIds">): string | null {
  switch (c.type) {
    case "SERVICE_IS":
      return ctx.job && c.values.includes(ctx.job.serviceCode) ? null : "The service doesn't match.";
    case "BRAND_IS":
      return (ctx.job?.brand ?? ctx.contact?.brand) === c.value ? null : "The brand doesn't match.";
    case "HAS_TAG":
      return ctx.tagIds.has(c.tagId) ? null : "It doesn't have the required tag.";
    case "NOT_TAG":
      return ctx.tagIds.has(c.tagId) ? "It has a tag that excludes it." : null;
    case "HAS_EMAIL":
      return ctx.contact?.emails.length ? null : "The contact has no email.";
    case "HAS_PHONE":
      return ctx.contact?.phones.length ? null : "The contact has no phone.";
  }
}

function entry(at: Date, step: number | null, outcome: LogEntry["outcome"], note: string): LogEntry {
  return { at: at.toISOString(), step, outcome, note };
}

type StepResult =
  | { kind: "next"; log?: LogEntry }
  | { kind: "wait"; until: Date; log?: LogEntry }
  | { kind: "stop"; log: LogEntry };

type Settings = typeof s.settings.$inferSelect;

async function runStep(tx: Tx, w: Workflow, run: Run, ctx: Ctx, step: Step, i: number, cfg: Settings | undefined, now: Date): Promise<StepResult> {
  const label = `${i + 1}. ${STEP_LABELS[step.type]}`;
  const ok = (note: string): StepResult => ({ kind: "next", log: entry(now, i, "ok", `${label}: ${note}`) });
  const skipped = (note: string): StepResult => ({ kind: "next", log: entry(now, i, "skipped", `${label}: ${note}`) });

  switch (step.type) {
    case "WAIT":
      return { kind: "wait", until: new Date(now.getTime() + waitMs(step)), log: entry(now, i, "waiting", `${label} ${step.amount} ${step.unit}.`) };

    case "SEND_EMAIL":
    case "SEND_SMS": {
      const c = ctx.contact;
      if (!c) return skipped("no client contact to message.");
      if (c.doNotContact) return skipped(`${c.firstName ?? "The contact"} is marked do-not-contact.`);
      const brand = ctx.job?.brand ?? c.brand;
      const vars = await templateVars(tx, { contactId: c.id, jobId: ctx.job?.id });
      // Blank fields show as [scheduled date] etc., so whoever approves the draft sees what to fill in.
      const render = (t: string) => renderTemplate(t, vars, { missing: "placeholder" });
      let missing: string[];
      if (step.type === "SEND_EMAIL") {
        const to = c.emails[0];
        if (!to) return skipped("the contact has no email.");
        const subject = render(step.subject);
        const text = render(step.body);
        missing = [...subject.missing, ...text.missing];
        await createDraft(tx, { channel: "EMAIL", source: "SYSTEM", templateKey: `${WORKFLOW_TEMPLATE_PREFIX}${w.id}`, toAddress: to, fromEmail: cfg?.defaultFromEmail ?? null, subject: subject.text, body: text.text, brand, contactId: c.id, jobId: ctx.job?.id ?? null });
      } else {
        const to = c.phones[0];
        if (!to) return skipped("the contact has no phone.");
        const [line] = await tx.select().from(s.phoneLines).where(eq(s.phoneLines.brand, brand)).limit(1);
        if (!line) return skipped(`no Quo line is set up for ${brand === "GAS_PRO" ? "Gas Pro" : "ESS"}.`);
        const text = render(step.body);
        missing = text.missing;
        await createDraft(tx, { channel: "SMS", source: "SYSTEM", templateKey: `${WORKFLOW_TEMPLATE_PREFIX}${w.id}`, toAddress: to, fromLineId: line.id, body: text.text, brand, contactId: c.id, jobId: ctx.job?.id ?? null });
      }
      const what = step.type === "SEND_EMAIL" ? "email" : "text";
      const gaps = missing.length ? ` Fill in ${[...new Set(missing)].join(", ").replace(/_/g, " ")} before sending.` : "";
      return ok(`${what} drafted in the Outbox for someone to approve.${gaps}`);
    }

    case "CREATE_TASK": {
      const vars = await templateVars(tx, { contactId: ctx.contact?.id, jobId: ctx.job?.id });
      const assignee = ctx.job?.assignedTo ?? (await tx.select({ id: s.profiles.userId }).from(s.profiles).where(eq(s.profiles.role, "OWNER")).limit(1))[0]?.id ?? null;
      await tx.insert(s.tasks).values({
        title: renderTemplate(step.title, vars, { missing: "placeholder" }).text,
        description: `Created by the “${w.name}” workflow.`,
        source: "SYSTEM_RULE",
        assignee,
        jobId: ctx.job?.id ?? null,
        contactId: ctx.contact?.id ?? null,
        propertyId: ctx.job?.propertyId ?? null,
        dueAt: new Date(now.getTime() + step.dueInDays * 86_400_000),
      });
      return ok("task created.");
    }

    case "NOTIFY_OWNER": {
      const vars = await templateVars(tx, { contactId: ctx.contact?.id, jobId: ctx.job?.id });
      const owners = await tx.select({ id: s.profiles.userId }).from(s.profiles).where(eq(s.profiles.role, "OWNER"));
      const msg = renderTemplate(step.message, vars, { missing: "placeholder" }).text;
      await tx.insert(s.tasks).values(
        (owners.length ? owners : [{ id: null }]).map((o) => ({
          title: msg.slice(0, 200),
          description: `From the “${w.name}” workflow.`,
          source: "SYSTEM_RULE" as const,
          assignee: o.id,
          jobId: ctx.job?.id ?? null,
          contactId: ctx.contact?.id ?? null,
          dueAt: now,
        })),
      );
      return ok("owner notified (task).");
    }

    case "ADD_TAG":
    case "REMOVE_TAG": {
      const id = step.target === "job" ? ctx.job?.id : step.target === "contact" ? ctx.contact?.id : ctx.orgId;
      if (!id) return skipped(`there's no ${step.target === "organization" ? "company" : step.target} to tag.`);
      const [tag] = await tx.select({ name: s.tags.name }).from(s.tags).where(eq(s.tags.id, step.tagId));
      if (!tag) return skipped("that tag was deleted.");
      if (step.type === "ADD_TAG") await addTag(tx, step.target, id, step.tagId);
      else await removeTag(tx, step.target, id, step.tagId);
      ctx.tagIds[step.type === "ADD_TAG" ? "add" : "delete"](step.tagId);
      return ok(`${step.type === "ADD_TAG" ? "added" : "removed"} “${tag.name}”.`);
    }

    case "MOVE_STAGE": {
      if (!ctx.job) return skipped("this run has no job.");
      if (ctx.job.stage === step.stage) return skipped("the job is already in that stage.");
      try {
        // Savepoint: a stage rule refusing the move must not undo the run's earlier steps.
        await tx.transaction((sp) => sp.update(s.jobs).set({ stage: step.stage }).where(eq(s.jobs.id, ctx.job!.id)));
      } catch (e) {
        return { kind: "next", log: entry(now, i, "failed", `${label}: ${stageRuleMessage(e) ?? (e as Error).message.slice(0, 200)}`) };
      }
      ctx.job = { ...ctx.job, stage: step.stage };
      return ok(`moved to ${step.stage.replace(/_/g, " ").toLowerCase()}.`);
    }

    case "STOP_IF_REPLIED": {
      const who = [ctx.job ? eq(s.activities.jobId, ctx.job.id) : undefined, ctx.contact ? eq(s.activities.contactId, ctx.contact.id) : undefined].filter(Boolean);
      if (!who.length) return ok("nothing to check.");
      const [reply] = await tx
        .select({ id: s.activities.id })
        .from(s.activities)
        // Strictly after the event: a run started by an incoming message mustn't stop on that same message.
        .where(and(eq(s.activities.direction, "INBOUND"), gt(s.activities.occurredAt, run.eventAt), or(...who)))
        .limit(1);
      return reply ? { kind: "stop", log: entry(now, i, "stopped", `${label}: the client replied, so the workflow stopped here.`) } : ok("no reply yet, carrying on.");
    }
  }
}

/** Carries one locked run forward. */
async function advanceRun(tx: Tx, run: Run, w: Workflow, cfg: Settings | undefined, now: Date): Promise<void> {
  const log = [...run.log];
  const save = (patch: Partial<typeof s.workflowRuns.$inferInsert>) => tx.update(s.workflowRuns).set({ log, updatedAt: now, ...patch }).where(eq(s.workflowRuns.id, run.id));

  const def = workflowDefinition(w);
  if (!def) {
    log.push(entry(now, null, "failed", "The workflow's settings are invalid; open it and save it again."));
    await save({ status: "FAILED" });
    return;
  }
  if (!w.active || w.archivedAt) {
    log.push(entry(now, null, "stopped", "The workflow was switched off."));
    await save({ status: "STOPPED" });
    return;
  }

  const ctx = await loadContext(tx, run);
  if (ctx.job?.airnycCaseId || ctx.job?.pipelineKey === "AIRNYC") {
    log.push(entry(now, null, "skipped", "AIRnyc jobs are never automated."));
    await save({ status: "SKIPPED" });
    return;
  }
  if (ctx.job?.archivedAt || ctx.contact?.archivedAt) {
    log.push(entry(now, null, "stopped", "The record was archived."));
    await save({ status: "STOPPED" });
    return;
  }
  if (run.stepIndex === 0 && run.status === "RUNNING") {
    for (const c of def.conditions) {
      const why = failedCondition(c, ctx);
      if (why) {
        log.push(entry(now, null, "skipped", `Conditions not met: ${why}`));
        await save({ status: "SKIPPED" });
        return;
      }
    }
  }

  let i = run.stepIndex;
  while (i < def.steps.length) {
    const r = await runStep(tx, w, run, ctx, def.steps[i], i, cfg, now);
    if (r.log) log.push(r.log);
    if (r.kind === "stop") {
      await save({ status: "STOPPED", stepIndex: i });
      return;
    }
    if (r.kind === "wait") {
      await save({ status: "WAITING", stepIndex: i + 1, resumeAt: r.until });
      return;
    }
    i++;
  }
  log.push(entry(now, null, "ok", "Finished."));
  await save({ status: "DONE", stepIndex: i });
}

/** Advances every due run. Returns counts for the worker log. */
export async function advanceWorkflowRuns(db: Db, now = new Date()): Promise<{ advanced: number; failed: number }> {
  const [cfg] = await db.select().from(s.settings);
  const due = await db
    .select({ id: s.workflowRuns.id })
    .from(s.workflowRuns)
    .where(and(inArray(s.workflowRuns.status, ["RUNNING", "WAITING"]), lte(s.workflowRuns.resumeAt, now)))
    .orderBy(asc(s.workflowRuns.resumeAt))
    .limit(ADVANCE_BATCH);

  let advanced = 0;
  let failed = 0;
  for (const { id } of due) {
    try {
      const done = await db.transaction(async (tx) => {
        const [run] = await tx.select().from(s.workflowRuns).where(and(eq(s.workflowRuns.id, id), inArray(s.workflowRuns.status, ["RUNNING", "WAITING"]), lte(s.workflowRuns.resumeAt, now))).for("update", { skipLocked: true });
        if (!run) return false; // another worker has it, or it already moved on
        const [w] = await tx.select().from(s.workflows).where(eq(s.workflows.id, run.workflowId));
        await advanceRun(tx, run, w, cfg, now);
        return true;
      });
      if (done) advanced++;
    } catch (e) {
      failed++;
      const note = entry(now, null, "failed", `Error: ${(e as Error).message.slice(0, 300)}`);
      await db
        .update(s.workflowRuns)
        .set({ status: "FAILED", updatedAt: now, log: sql`${s.workflowRuns.log} || ${JSON.stringify([note])}::jsonb` })
        .where(eq(s.workflowRuns.id, id));
    }
  }
  return { advanced, failed };
}

/** One worker tick: enrol new events, then advance due runs. Never sends anything. */
export async function runAutomations(db: Db, now = new Date()) {
  const started = await enrolWorkflowEvents(db, now);
  const r = await advanceWorkflowRuns(db, now);
  return { started, ...r };
}
