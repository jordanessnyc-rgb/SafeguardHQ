/**
 * Read-only CRM tools for Claude (Phase 5 MCP server). Every function runs as the token's user
 * (RLS: a VA's token never sees money). AIRnyc jobs, cases and members are ALWAYS excluded —
 * tool results go to an AI, and SPEC §9.4 / CLAUDE.md rule 5 keep AIRnyc data out of the AI layer.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import { arAging } from "@/lib/money/reports";

const notAirnycJob = and(isNull(s.jobs.airnycCaseId), sql`${s.jobs.serviceCode} <> 'AIRNYC'`);
/** Contacts tied to AIRnyc (member contacts, sealed messages) are never returned. */
const notAirnycContact = sql`not exists (select 1 from ${s.activities} a where a.contact_id = ${s.contacts.id} and (a.sensitive or a.airnyc_case_id is not null))
  and not exists (select 1 from ${s.jobs} j where j.client_contact_id = ${s.contacts.id} and (j.airnyc_case_id is not null or j.service_code = 'AIRNYC'))`;

const addr = (p: { addressLine: string | null; unit: string | null; borough: string | null } | null) => (p?.addressLine ? [p.addressLine, p.unit && `Apt ${p.unit}`, p.borough].filter(Boolean).join(", ") : null);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export async function searchJobs(tx: Tx, a: { query?: string; stage?: string; service_code?: string; limit?: number }) {
  const q = a.query?.trim();
  const rows = await tx
    .select({ job: s.jobs, addressLine: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough, org: s.organizations.name, cFirst: s.contacts.firstName, cLast: s.contacts.lastName })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .where(
      and(
        isNull(s.jobs.archivedAt),
        notAirnycJob,
        a.stage ? eq(s.jobs.stage, a.stage) : undefined,
        a.service_code ? sql`${s.jobs.serviceCode} = ${a.service_code}` : undefined,
        q ? or(ilike(s.jobs.jobNumber, `%${q}%`), ilike(s.jobs.title, `%${q}%`), ilike(s.properties.addressLine, `%${q}%`), ilike(s.organizations.name, `%${q}%`), sql`(${s.contacts.firstName} || ' ' || ${s.contacts.lastName}) ilike ${`%${q}%`}`) : undefined,
      ),
    )
    .orderBy(desc(s.jobs.updatedAt))
    .limit(Math.min(a.limit ?? 20, 50));
  return rows.map((r) => ({
    job_number: r.job.jobNumber,
    service: label(SERVICE_LABELS, r.job.serviceCode),
    stage: r.job.stage,
    address: addr(r),
    client: r.org ?? (r.cFirst || r.cLast ? personName({ firstName: r.cFirst, lastName: r.cLast }) : null),
    scheduled: r.job.scheduledAt?.toISOString() ?? null,
    delivered: day(r.job.deliveredAt),
  }));
}

export async function getJob(tx: Tx, jobNumber: string) {
  const [r] = await tx
    .select({ job: s.jobs, addressLine: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough, org: s.organizations.name, contact: s.contacts })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .where(and(eq(s.jobs.jobNumber, jobNumber.trim().toUpperCase()), isNull(s.jobs.archivedAt), notAirnycJob));
  if (!r) return null;
  const id = r.job.id;
  const [samples, tasks, docs, fin] = await Promise.all([
    tx.select({ sample_id: s.samples.sampleId, type: s.samples.type, status: s.samples.status }).from(s.samples).where(and(eq(s.samples.jobId, id), isNull(s.samples.archivedAt))),
    tx.select({ title: s.tasks.title, due: s.tasks.dueAt, status: s.tasks.status }).from(s.tasks).where(and(eq(s.tasks.jobId, id), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]))).orderBy(asc(s.tasks.dueAt)),
    tx.select({ kind: s.documents.kind, status: s.documents.status, title: s.documents.title }).from(s.documents).where(and(eq(s.documents.jobId, id), isNull(s.documents.archivedAt))),
    tx.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, id)), // RLS: empty for a VA
  ]);
  const f = fin[0];
  return {
    job_number: r.job.jobNumber,
    service: label(SERVICE_LABELS, r.job.serviceCode),
    stage: r.job.stage,
    in_stage_since: day(r.job.stageEnteredAt),
    address: addr(r),
    client: r.org ?? (r.contact ? personName(r.contact) : null),
    contact: r.contact ? { name: personName(r.contact), email: r.contact.emails[0] ?? null, phone: r.contact.phones[0] ?? null } : null,
    scheduled: r.job.scheduledAt?.toISOString() ?? null,
    field_completed: day(r.job.fieldCompletedAt),
    delivered: day(r.job.deliveredAt),
    next_cycle_due: r.job.nextCycleDue,
    samples,
    open_tasks: tasks.map((t) => ({ title: t.title, due: t.due?.toISOString() ?? null })),
    documents: docs,
    ...(f ? { financials: { quoted: f.quotedAmount, invoice_status: f.invoiceStatus, amount_paid: f.amountPaid, gross_margin: f.grossMargin } } : {}),
  };
}

export async function searchContacts(tx: Tx, query: string, limit = 20) {
  const q = `%${query.trim()}%`;
  const rows = await tx
    .select({ c: s.contacts, org: s.organizations.name })
    .from(s.contacts)
    .leftJoin(s.organizations, eq(s.organizations.id, s.contacts.orgId))
    .where(and(isNull(s.contacts.archivedAt), notAirnycContact, or(sql`(coalesce(${s.contacts.firstName},'') || ' ' || coalesce(${s.contacts.lastName},'')) ilike ${q}`, ilike(s.organizations.name, q), sql`array_to_string(${s.contacts.emails}, ' ') ilike ${q}`, sql`array_to_string(${s.contacts.phones}, ' ') ilike ${q}`)))
    .limit(Math.min(limit, 50));
  return rows.map((r) => ({ name: personName(r.c), organization: r.org, emails: r.c.emails, phones: r.c.phones, do_not_contact: r.c.doNotContact }));
}

export async function propertyViolations(tx: Tx, a: { address?: string; bbl?: string }) {
  const props = await tx
    .select()
    .from(s.properties)
    .where(and(isNull(s.properties.archivedAt), a.bbl ? eq(s.properties.bbl, a.bbl) : a.address ? ilike(s.properties.addressLine, `%${a.address.trim()}%`) : sql`false`, sql`not exists (select 1 from ${s.jobs} j where j.property_id = ${s.properties.id} and (j.airnyc_case_id is not null or j.service_code = 'AIRNYC'))`))
    .limit(5);
  const out = [];
  for (const p of props) {
    const v = await tx
      .select({ source: s.propertyViolations.source, class: s.propertyViolations.class, issued: s.propertyViolations.issuedDate, status: s.propertyViolations.status, description: s.propertyViolations.description })
      .from(s.propertyViolations)
      .where(and(eq(s.propertyViolations.propertyId, p.id), eq(s.propertyViolations.isOpen, true)))
      .orderBy(desc(s.propertyViolations.issuedDate))
      .limit(50);
    out.push({ address: addr(p), bbl: p.bbl, open_violations: v.length, violations: v });
  }
  return out;
}

export async function listTasks(tx: Tx, a: { overdue_only?: boolean; limit?: number }, now = new Date()) {
  const rows = await tx
    .select({ t: s.tasks, job: s.jobs.jobNumber })
    .from(s.tasks)
    .leftJoin(s.jobs, eq(s.jobs.id, s.tasks.jobId))
    .where(and(isNull(s.tasks.archivedAt), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]), isNull(s.tasks.airnycCaseId), a.overdue_only ? lt(s.tasks.dueAt, now) : undefined, sql`(${s.tasks.jobId} is null or ${notAirnycJob})`))
    .orderBy(asc(s.tasks.dueAt))
    .limit(Math.min(a.limit ?? 30, 100));
  return rows.map((r) => ({ title: r.t.title, due: r.t.dueAt?.toISOString() ?? null, job: r.job, source: r.t.source }));
}

export async function pipelineSummary(tx: Tx, isOwner: boolean, now = new Date()) {
  const stages = await tx
    .select({ stage: s.jobs.stage, n: sql<number>`count(*)::int` })
    .from(s.jobs)
    .where(and(isNull(s.jobs.archivedAt), notAirnycJob))
    .groupBy(s.jobs.stage);
  const [{ overdue }] = await tx.select({ overdue: sql<number>`count(*)::int` }).from(s.tasks).where(and(isNull(s.tasks.archivedAt), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]), lt(s.tasks.dueAt, now)));
  const bids = await tx
    .select({ title: s.bids.title, due: s.bids.dueAt, status: s.bids.status })
    .from(s.bids)
    .where(and(isNull(s.bids.archivedAt), inArray(s.bids.status, ["WATCHING", "GO_NO_GO", "DRAFTING"]), sql`${s.bids.dueAt} between ${now.toISOString()} and ${new Date(now.getTime() + 7 * 86_400_000).toISOString()}`));
  const ar = isOwner ? await arAging(tx, now) : null;
  return {
    jobs_by_stage: Object.fromEntries(stages.map((r) => [r.stage, r.n])),
    overdue_tasks: overdue,
    bids_due_in_7_days: bids.map((b) => ({ ...b, due: b.due?.toISOString() ?? null })),
    ...(ar ? { unpaid_invoices_total: ar.total, unpaid_by_age: ar.totalsByBucket } : {}),
  };
}
