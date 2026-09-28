/**
 * Proposal follow-ups (Phase 7d). A job that has sat in Proposal sent for the configured days
 * (settings.follow_up_days, default 3 and 7) with no reply from the client gets a follow-up DRAFT in
 * the Outbox and a task. Nothing is sent unless the matching auto-send switch is on (CLAUDE.md rule 6).
 *
 * - One draft + task per step per proposal, counted from when the job entered Proposal sent (so a job
 *   that goes back to Proposal sent starts over). With no phone or email on file, just the task.
 * - Any inbound call, text or email on the job or from its contact since then means they answered: stop.
 * - Text when the contact has a mobile number and there's a phone line; otherwise email.
 * - Do-not-contact and AIRnyc jobs are skipped; drafts are only made during business hours.
 */
import { and, count, countDistinct, eq, gte, inArray, isNull, like, or } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import { createDraft } from "@/lib/comms/outbound";
import { BRAND_INFO, renderTemplate } from "@/lib/comms/templates";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { ownerTask } from "@/lib/tasks";
import { isWithinBusinessHours } from "@/lib/time";

const DAY = 86_400_000;
const WAITING_STAGES = ["PROPOSAL_SENT"];
const TASK_PREFIX = "Follow up on the proposal for";

export type FollowUpOutcome = { jobNumber: string; step: number; channel: "SMS" | "EMAIL" | null };

export async function draftProposalFollowUps(db: Db, now = new Date()): Promise<FollowUpOutcome[]> {
  const [cfg] = await db.select().from(s.settings);
  if (!cfg?.followUpEnabled || !cfg.followUpDays.length) return [];
  if (!isWithinBusinessHours(now, cfg.businessHours as Record<string, { open: string; close: string } | null>)) return [];
  const steps = [...cfg.followUpDays].filter((d) => d > 0).sort((a, b) => a - b);

  const waiting = await db
    .select({ job: s.jobs, contact: s.contacts, address: s.properties.addressLine, unit: s.properties.unit })
    .from(s.jobs)
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .where(and(inArray(s.jobs.stage, WAITING_STAGES), isNull(s.jobs.archivedAt), isNull(s.jobs.airnycCaseId)))
    .limit(200);

  const out: FollowUpOutcome[] = [];
  for (const { job, contact, address, unit } of waiting) {
    if (!contact || contact.doNotContact || contact.archivedAt) continue;
    const since = job.stageEnteredAt;
    // Steps done = follow-up tasks made since the proposal went out (one insert per step, so one created_at).
    const [{ n: step }] = await db
      .select({ n: countDistinct(s.tasks.createdAt) })
      .from(s.tasks)
      .where(and(eq(s.tasks.jobId, job.id), eq(s.tasks.source, "SYSTEM_RULE"), like(s.tasks.title, `${TASK_PREFIX}%`), gte(s.tasks.createdAt, since)));
    if (step >= steps.length || now.getTime() - since.getTime() < steps[step] * DAY) continue;

    // They answered (any channel, on the job or from the person) → a person takes it from here.
    const [{ n: replies }] = await db
      .select({ n: count() })
      .from(s.activities)
      .where(and(eq(s.activities.direction, "INBOUND"), gte(s.activities.occurredAt, since), or(eq(s.activities.jobId, job.id), eq(s.activities.contactId, contact.id))));
    if (replies) continue;

    const phone = contact.phones[0];
    const email = contact.emails[0];
    const [line] = phone ? await db.select().from(s.phoneLines).where(eq(s.phoneLines.brand, job.brand)).limit(1) : [];
    const channel = phone && line ? "SMS" : email ? "EMAIL" : null;
    const vars = {
      first_name: contact.firstName,
      job_number: job.jobNumber,
      address: address ? `${address}${unit ? `, Apt ${unit}` : ""}` : "your property",
      brand_name: BRAND_INFO[job.brand].name,
      brand_phone: BRAND_INFO[job.brand].phone,
    };
    if (channel) {
      const key = channel === "SMS" ? "PROPOSAL_FOLLOWUP" : "PROPOSAL_FOLLOWUP_EMAIL";
      const [tpl] = await db.select().from(s.messageTemplates).where(and(eq(s.messageTemplates.key, key), eq(s.messageTemplates.active, true)));
      if (tpl) {
        await createDraft(db, {
          channel,
          source: "TEMPLATE",
          templateKey: key,
          toAddress: channel === "SMS" ? phone! : email!,
          fromLineId: channel === "SMS" ? line!.id : null,
          fromEmail: channel === "EMAIL" ? cfg.defaultFromEmail : null,
          subject: channel === "EMAIL" && tpl.subject ? renderTemplate(tpl.subject, vars).text : null,
          body: renderTemplate(tpl.body, vars).text,
          brand: job.brand,
          contactId: contact.id,
          jobId: job.id,
        });
      }
    }
    await ownerTask(db, {
      title: `${TASK_PREFIX} ${job.jobNumber} (${label(SERVICE_LABELS, job.serviceCode).toLowerCase()})`,
      description: channel
        ? `No reply ${steps[step]} days after the proposal went out. A follow-up ${channel === "SMS" ? "text" : "email"} is waiting in the Outbox for your OK.`
        : `No reply ${steps[step]} days after the proposal went out, and there's no phone or email on file to follow up with.`,
      jobId: job.id,
      contactId: contact.id,
      dueAt: now,
    });
    out.push({ jobNumber: job.jobNumber, step: step + 1, channel });
  }
  return out;
}
