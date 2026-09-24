/**
 * Compliance calendar (SPEC §6.6). When a job is Closed, its next cycle is computed from the rule
 * Jordan entered for that service (never hard-coded), and an outreach task is scheduled at the
 * rule's lead time. Runs from the worker; each job is handled once (jobs.cycle_scheduled_at).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import { ownerTask } from "@/lib/tasks";
import { fromNyInput, nyDate } from "@/lib/time";

/** "2026-01-31" + 1 month → "2026-02-28" (clamped to the month's last day). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export type CycleOutcome = { jobNumber: string; status: "scheduled" | "manual" | "kept"; nextCycleDue?: string | null };

export async function scheduleNextCycles(db: Db, now = new Date(), limit = 50): Promise<CycleOutcome[]> {
  const due = await db
    .select({ job: s.jobs, rule: s.complianceRules, address: s.properties.addressLine, borough: s.properties.borough, org: s.organizations.name, contactFirst: s.contacts.firstName, contactLast: s.contacts.lastName })
    .from(s.jobs)
    .innerJoin(s.complianceRules, and(eq(s.complianceRules.serviceCode, s.jobs.serviceCode), eq(s.complianceRules.active, true), isNull(s.complianceRules.archivedAt)))
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .where(and(eq(s.jobs.stage, "CLOSED"), isNull(s.jobs.cycleScheduledAt), isNull(s.jobs.archivedAt)))
    .limit(limit);

  const out: CycleOutcome[] = [];
  for (const { job, rule, address, borough, org, contactFirst, contactLast } of due) {
    // Claim first so two workers (or a retry) never create the outreach task twice.
    const [claimed] = await db.update(s.jobs).set({ cycleScheduledAt: now }).where(and(eq(s.jobs.id, job.id), isNull(s.jobs.cycleScheduledAt))).returning({ id: s.jobs.id });
    if (!claimed) continue;

    const where = [address, borough].filter(Boolean).join(", ") || "no property";
    const client = org ?? (contactFirst || contactLast ? personName({ firstName: contactFirst, lastName: contactLast }) : "the client");
    const service = label(SERVICE_LABELS, job.serviceCode);

    let next = job.nextCycleDue; // a date set by hand wins
    if (!next && rule.cycleMonths) {
      const base = job.fieldCompletedAt ?? job.deliveredAt ?? job.stageEnteredAt;
      next = addMonths(nyDate(base), rule.cycleMonths);
      await db.update(s.jobs).set({ nextCycleDue: next }).where(eq(s.jobs.id, job.id));
    }
    if (!next) {
      await ownerTask(db, {
        title: `Set the next ${service} cycle for ${job.jobNumber}`,
        description: `No cycle length is set for ${service}${rule.notes ? ` (rule note: ${rule.notes})` : ""}. Enter the next due date on the job.`,
        jobId: job.id,
        propertyId: job.propertyId,
      });
      out.push({ jobNumber: job.jobNumber, status: "manual", nextCycleDue: null });
      continue;
    }
    const reachOut = fromNyInput(`${addDays(next, -rule.leadTimeDays)}T09:00`);
    await ownerTask(db, {
      title: `${service} due ${next} — ${client}, ${where}`,
      description: `Next compliance cycle for ${job.jobNumber} is due ${next}. Reach out to book it${rule.notes ? `. Rule note: ${rule.notes}` : ""}.`,
      jobId: job.id,
      contactId: job.clientContactId,
      propertyId: job.propertyId,
      dueAt: reachOut > now ? reachOut : now,
    });
    out.push({ jobNumber: job.jobNumber, status: job.nextCycleDue ? "kept" : "scheduled", nextCycleDue: next });
  }
  return out;
}

export type UpcomingCycle = { jobId: string; jobNumber: string; serviceCode: string; due: string; client: string | null; orgId: string | null; address: string | null; borough: string | null };

/** Calendar view: jobs whose next cycle falls in [from, to] (YYYY-MM-DD). */
export async function upcomingCycles(conn: Db | Tx, from: string, to: string, filter: { orgId?: string; borough?: string } = {}): Promise<UpcomingCycle[]> {
  const rows = await conn
    .select({ job: s.jobs, org: s.organizations.name, address: s.properties.addressLine, borough: s.properties.borough, contactFirst: s.contacts.firstName, contactLast: s.contacts.lastName })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .where(
      and(
        isNull(s.jobs.archivedAt),
        sql`${s.jobs.nextCycleDue} between ${from} and ${to}`,
        filter.orgId ? eq(s.jobs.clientOrgId, filter.orgId) : undefined,
        filter.borough ? eq(s.properties.borough, filter.borough) : undefined,
      ),
    )
    .orderBy(s.jobs.nextCycleDue);
  return rows.map((r) => ({
    jobId: r.job.id,
    jobNumber: r.job.jobNumber,
    serviceCode: r.job.serviceCode,
    due: r.job.nextCycleDue!,
    client: r.org ?? (r.contactFirst || r.contactLast ? personName({ firstName: r.contactFirst, lastName: r.contactLast }) : null),
    orgId: r.job.clientOrgId,
    address: r.address,
    borough: r.borough,
  }));
}
