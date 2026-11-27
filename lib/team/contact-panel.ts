/**
 * The client panel beside an open message in Messages: who the lead/client is and everything the team
 * has on them. Runs in the caller's RLS transaction, so a VA never sees priced documents (RLS hides
 * them) and nothing owner-only leaks into the panel.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";

export type ContactPanelData = Awaited<ReturnType<typeof loadContactPanel>>;

export async function loadContactPanel(tx: Tx, contactId: string, now = new Date()) {
  const [contact] = await tx
    .select({
      id: s.contacts.id,
      firstName: s.contacts.firstName,
      lastName: s.contacts.lastName,
      emails: s.contacts.emails,
      phones: s.contacts.phones,
      title: s.contacts.title,
      doNotContact: s.contacts.doNotContact,
      orgId: s.contacts.orgId,
      orgName: s.organizations.name,
    })
    .from(s.contacts)
    .leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId))
    .where(eq(s.contacts.id, contactId));
  if (!contact) return null;

  const jobs = await tx
    .select({ id: s.jobs.id, jobNumber: s.jobs.jobNumber, serviceCode: s.jobs.serviceCode, stage: s.jobs.stage, scheduledAt: s.jobs.scheduledAt, address: s.properties.addressLine, unit: s.properties.unit })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .where(and(eq(s.jobs.clientContactId, contactId), isNull(s.jobs.archivedAt)))
    .orderBy(desc(s.jobs.createdAt))
    .limit(50);
  const jobIds = jobs.map((j) => j.id);

  const tasks = await tx
    .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, status: s.tasks.status, jobId: s.tasks.jobId })
    .from(s.tasks)
    .where(
      and(
        isNull(s.tasks.archivedAt),
        inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]),
        jobIds.length ? or(eq(s.tasks.contactId, contactId), inArray(s.tasks.jobId, jobIds)) : eq(s.tasks.contactId, contactId),
      ),
    )
    .orderBy(sql`${s.tasks.dueAt} asc nulls last`)
    .limit(8);

  // Notes: internal notes and notes typed on the contact or their jobs (sealed AIRnyc notes stay sealed).
  const notes = await tx
    .select({ id: s.activities.id, body: s.activities.body, sensitive: s.activities.sensitive, occurredAt: s.activities.occurredAt, authorId: s.activities.createdBy, jobId: s.activities.jobId })
    .from(s.activities)
    .where(
      and(
        eq(s.activities.type, "NOTE"),
        jobIds.length ? or(eq(s.activities.contactId, contactId), inArray(s.activities.jobId, jobIds)) : eq(s.activities.contactId, contactId),
      ),
    )
    .orderBy(desc(s.activities.occurredAt))
    .limit(6);

  // Appointments: scheduled inspections, upcoming first, then the most recent past ones.
  const scheduled = jobs.filter((j) => j.scheduledAt);
  const upcoming = scheduled.filter((j) => j.scheduledAt! >= now).sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime());
  const past = scheduled.filter((j) => j.scheduledAt! < now).sort((a, b) => b.scheduledAt!.getTime() - a.scheduledAt!.getTime());
  const appointments = [...upcoming.slice(0, 4), ...past.slice(0, Math.max(0, 4 - upcoming.length))].map((j) => ({ ...j, upcoming: j.scheduledAt! >= now }));

  const documents = jobIds.length
    ? await tx
        .select({ id: s.documents.id, title: s.documents.title, kind: s.documents.kind, jobId: s.documents.jobId, createdAt: s.documents.createdAt })
        .from(s.documents)
        .where(and(inArray(s.documents.jobId, jobIds), isNull(s.documents.archivedAt), isNotNull(s.documents.storagePath)))
        .orderBy(desc(s.documents.createdAt))
        .limit(8)
    : [];

  return { contact, jobs, tasks, notes, appointments, documents, jobNumber: new Map(jobs.map((j) => [j.id, j.jobNumber])) };
}

