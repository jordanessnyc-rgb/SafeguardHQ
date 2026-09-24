/**
 * Scheduled inspections → Titan calendar (SPEC §6.3). Every scheduled, open job has one event
 * (UID = job id); it is rewritten only when its content changes, and deleted when the job is
 * unscheduled, Lost or archived. Events have no attendees, so nothing is ever sent to a client
 * (CLAUDE.md rule 6). AIRnyc jobs carry no member details — only the case reference and address.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import type { CalendarSink } from "@/lib/integrations/titan-calendar";
import { buildIcs } from "./ics";

export const EVENT_MINUTES = 120;
const filename = (jobId: string) => `ess-${jobId}.ics`;

export async function syncCalendar(db: Db, cal: CalendarSink, now = new Date(), appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "") {
  const upcoming = await db
    .select({ job: s.jobs, prop: s.properties, org: s.organizations.name, contact: s.contacts, caseId: s.airnycCases.caseId })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .leftJoin(s.airnycCases, eq(s.airnycCases.id, s.jobs.airnycCaseId))
    .where(and(isNotNull(s.jobs.scheduledAt), gt(s.jobs.scheduledAt, new Date(now.getTime() - 86_400_000)), isNull(s.jobs.archivedAt), ne(s.jobs.stage, "LOST")))
    .limit(500);

  const out = { written: 0, removed: 0, errors: 0 };
  for (const { job, prop, org, contact, caseId } of upcoming) {
    const airnyc = job.airnycCaseId != null;
    const address = prop ? [prop.addressLine, prop.unit && `Apt ${prop.unit}`, prop.borough, prop.zip].filter(Boolean).join(", ") : null;
    const who = airnyc ? null : (org ?? (contact ? personName(contact) : null));
    const description = [
      `${label(SERVICE_LABELS, job.serviceCode)} · ${job.jobNumber}`,
      airnyc ? `AIRnyc case ${caseId ?? ""} — member details are in the CRM only.` : who && `Client: ${who}`,
      !airnyc && contact?.phones[0] && `Phone: ${formatPhone(contact.phones[0])}`,
      !airnyc && job.title && job.title,
      appUrl && `${appUrl}/jobs/${job.id}`,
    ]
      .filter(Boolean)
      .join("\n");
    const content = { summary: `${label(SERVICE_LABELS, job.serviceCode)} — ${job.jobNumber}${prop ? ` — ${prop.addressLine}` : ""}`, location: address, description, start: job.scheduledAt!.toISOString() };
    const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
    if (hash === job.calendarHash) continue;
    const sequence = job.calendarHash ? job.calendarSequence + 1 : 0;
    try {
      await cal.put(
        filename(job.id),
        buildIcs({ uid: `${job.id}@crm.ess-nyc.com`, start: job.scheduledAt!, end: new Date(job.scheduledAt!.getTime() + EVENT_MINUTES * 60_000), summary: content.summary, location: address, description, url: appUrl ? `${appUrl}/jobs/${job.id}` : null, sequence }, now),
      );
      await db.update(s.jobs).set({ calendarHash: hash, calendarSequence: sequence, calendarError: null }).where(eq(s.jobs.id, job.id));
      out.written++;
    } catch (e) {
      await db.update(s.jobs).set({ calendarError: (e as Error).message.slice(0, 300) }).where(eq(s.jobs.id, job.id));
      out.errors++;
    }
  }

  // Off the schedule (unscheduled, Lost, archived) → remove the event.
  const stale = await db
    .select({ id: s.jobs.id })
    .from(s.jobs)
    .where(and(isNotNull(s.jobs.calendarHash), or(isNull(s.jobs.scheduledAt), isNotNull(s.jobs.archivedAt), eq(s.jobs.stage, "LOST"))))
    .limit(200);
  for (const { id } of stale) {
    try {
      await cal.remove(filename(id));
      await db.update(s.jobs).set({ calendarHash: null, calendarError: null, calendarSequence: sql`${s.jobs.calendarSequence} + 1` }).where(eq(s.jobs.id, id));
      out.removed++;
    } catch (e) {
      await db.update(s.jobs).set({ calendarError: (e as Error).message.slice(0, 300) }).where(eq(s.jobs.id, id));
      out.errors++;
    }
  }
  return out;
}
