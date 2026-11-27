/**
 * Data for the 3-column contact page: details (left), conversations (middle), and the side panel
 * (notes, tasks, appointments, documents, jobs & properties). Runs in the viewer's RLS transaction, so
 * VAs never see priced documents or owner-only rows.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";

export const PANELS = ["notes", "tasks", "appointments", "documents", "jobs"] as const;
export type Panel = (typeof PANELS)[number];
export const LEFT_TABS = ["fields", "dnd", "actions"] as const;
export type LeftTab = (typeof LEFT_TABS)[number];

export async function loadContactWorkspace(tx: Tx, contactId: string, opts: { noteSearch?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.id, contactId));
  if (!contact) return null;
  const [org] = contact.orgId ? await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(eq(s.organizations.id, contact.orgId)) : [];

  const jobs = await tx
    .select({ id: s.jobs.id, jobNumber: s.jobs.jobNumber, serviceCode: s.jobs.serviceCode, stage: s.jobs.stage, pipelineKey: s.jobs.pipelineKey, scheduledAt: s.jobs.scheduledAt, propertyId: s.jobs.propertyId, address: s.properties.addressLine, unit: s.properties.unit, createdAt: s.jobs.createdAt })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .where(and(eq(s.jobs.clientContactId, contactId), isNull(s.jobs.archivedAt)))
    .orderBy(desc(s.jobs.createdAt))
    .limit(100);
  const jobIds = jobs.map((j) => j.id);
  const mineOrJobs = <C extends typeof s.activities.contactId | typeof s.tasks.contactId, J extends typeof s.activities.jobId | typeof s.tasks.jobId>(c: C, j: J) =>
    jobIds.length ? or(eq(c, contactId), inArray(j, jobIds)) : eq(c, contactId);

  // Conversations: emails, texts and calls with this person, oldest → newest (newest at the bottom).
  const conversation = (
    await tx
      .select()
      .from(s.activities)
      .where(and(eq(s.activities.contactId, contactId), inArray(s.activities.type, ["EMAIL_IN", "EMAIL_OUT", "SMS", "CALL"]), sql`not (coalesce(${s.activities.raw}, '{}'::jsonb) ? 'trashed')`))
      .orderBy(desc(s.activities.occurredAt))
      .limit(150)
  ).reverse();

  const q = opts.noteSearch?.trim();
  const notes = await tx
    .select({ id: s.activities.id, body: s.activities.body, subject: s.activities.subject, sensitive: s.activities.sensitive, occurredAt: s.activities.occurredAt, authorId: s.activities.createdBy, jobId: s.activities.jobId, authorName: s.profiles.fullName })
    .from(s.activities)
    .leftJoin(s.profiles, eq(s.profiles.userId, s.activities.createdBy))
    .where(and(eq(s.activities.type, "NOTE"), mineOrJobs(s.activities.contactId, s.activities.jobId), q ? ilike(s.activities.body, `%${q}%`) : undefined))
    .orderBy(desc(s.activities.occurredAt))
    .limit(50);

  const tasks = await tx
    .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, status: s.tasks.status, jobId: s.tasks.jobId })
    .from(s.tasks)
    .where(and(isNull(s.tasks.archivedAt), ne(s.tasks.status, "CANCELED"), mineOrJobs(s.tasks.contactId, s.tasks.jobId)))
    .orderBy(asc(s.tasks.status), sql`${s.tasks.dueAt} asc nulls last`)
    .limit(50);

  const scheduled = jobs.filter((j) => j.scheduledAt);
  const appointments = {
    upcoming: scheduled.filter((j) => j.scheduledAt! >= now).sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime()),
    past: scheduled.filter((j) => j.scheduledAt! < now).sort((a, b) => b.scheduledAt!.getTime() - a.scheduledAt!.getTime()).slice(0, 10),
  };

  const documents = jobIds.length
    ? await tx
        .select({ id: s.documents.id, title: s.documents.title, kind: s.documents.kind, jobId: s.documents.jobId, createdAt: s.documents.createdAt })
        .from(s.documents)
        .where(and(inArray(s.documents.jobId, jobIds), isNull(s.documents.archivedAt), isNotNull(s.documents.storagePath)))
        .orderBy(desc(s.documents.createdAt))
        .limit(50)
    : [];

  const properties = await tx
    .select({ role: s.propertyRoles.role, id: s.properties.id, address: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough })
    .from(s.propertyRoles)
    .innerJoin(s.properties, eq(s.properties.id, s.propertyRoles.propertyId))
    .where(and(eq(s.propertyRoles.contactId, contactId), eq(s.propertyRoles.active, true)));

  const orgs = await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt)).orderBy(asc(s.organizations.name));

  return {
    contact,
    org: org ?? null,
    orgs,
    jobs,
    conversation,
    notes,
    tasks,
    appointments,
    documents,
    properties,
    jobNumber: new Map(jobs.map((j) => [j.id, j.jobNumber])),
    counts: { notes: notes.length, tasks: tasks.filter((t) => t.status !== "DONE").length, appointments: appointments.upcoming.length, documents: documents.length, jobs: jobs.length },
  };
}

export type ContactWorkspace = NonNullable<Awaited<ReturnType<typeof loadContactWorkspace>>>;
