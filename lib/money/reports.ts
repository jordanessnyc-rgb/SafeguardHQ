/**
 * OWNER-only money reports (SPEC §6.2 "Reports"): A/R aging by client type, and revenue / sub cost /
 * lab cost / margin by service code and by month. Callers must run these as the OWNER — RLS on
 * invoices_cache / job_financials returns nothing to anyone else.
 */
import { and, eq, gt, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";

type Conn = Db | Tx;

export const CLIENT_TYPES = ["PRIVATE", "MANAGEMENT_CO", "AIRNYC", "GOVERNMENT"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function clientTypeOf(o: { serviceCode?: string | null; airnycCaseId?: string | null; orgType?: string | null }): ClientType {
  if (o.serviceCode === "AIRNYC" || o.airnycCaseId) return "AIRNYC";
  if (o.orgType === "GOV_AGENCY") return "GOVERNMENT";
  if (o.orgType === "MANAGEMENT_CO") return "MANAGEMENT_CO";
  return "PRIVATE";
}

/** Days past due → bucket. Not yet due (or no due date and issued today) is "current". */
export function agingBucket(dueDate: string | null, issuedDate: string | null, termsDays: number, asOf: Date): AgingBucket {
  const due = dueDate ? new Date(`${dueDate}T12:00:00Z`) : issuedDate ? new Date(new Date(`${issuedDate}T12:00:00Z`).getTime() + termsDays * 86_400_000) : null;
  if (!due) return "current";
  const days = Math.floor((asOf.getTime() - due.getTime()) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export type ArRow = {
  freshbooksInvoiceId: string;
  invoiceNumber: string | null;
  jobId: string | null;
  jobNumber: string | null;
  client: string | null;
  clientType: ClientType;
  outstanding: number;
  bucket: AgingBucket;
  dueAt: string | null;
};

export async function arAging(conn: Conn, asOf = new Date()) {
  const [cfg] = await conn.select({ terms: s.settings.invoicePaymentTermsDays }).from(s.settings);
  const rows = await conn
    .select({
      inv: s.invoicesCache,
      jobNumber: s.jobs.jobNumber,
      serviceCode: s.jobs.serviceCode,
      airnycCaseId: s.jobs.airnycCaseId,
      orgName: s.organizations.name,
      orgType: s.organizations.type,
      contactFirst: s.contacts.firstName,
      contactLast: s.contacts.lastName,
    })
    .from(s.invoicesCache)
    .leftJoin(s.jobs, eq(s.jobs.id, s.invoicesCache.jobId))
    .leftJoin(s.organizations, eq(s.organizations.id, sql`coalesce(${s.invoicesCache.orgId}, ${s.jobs.clientOrgId})`))
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
    .where(and(gt(s.invoicesCache.outstanding, "0"), notInArray(sql`coalesce(${s.invoicesCache.status}, '')`, ["draft", "void", "deleted"])));

  const items: ArRow[] = rows.map((r) => ({
    freshbooksInvoiceId: r.inv.freshbooksInvoiceId,
    invoiceNumber: r.inv.invoiceNumber,
    jobId: r.inv.jobId,
    jobNumber: r.jobNumber,
    client: r.orgName ?? ([r.contactFirst, r.contactLast].filter(Boolean).join(" ") || null),
    clientType: clientTypeOf({ serviceCode: r.serviceCode, airnycCaseId: r.airnycCaseId, orgType: r.orgType }),
    outstanding: Number(r.inv.outstanding ?? 0),
    bucket: agingBucket(r.inv.dueAt, r.inv.issuedAt, cfg?.terms ?? 30, asOf),
    dueAt: r.inv.dueAt,
  }));

  const grid = Object.fromEntries(CLIENT_TYPES.map((t) => [t, Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]))])) as Record<ClientType, Record<AgingBucket, number>>;
  for (const i of items) grid[i.clientType][i.bucket] = round2(grid[i.clientType][i.bucket] + i.outstanding);
  const totalsByBucket = Object.fromEntries(AGING_BUCKETS.map((b) => [b, round2(items.filter((i) => i.bucket === b).reduce((n, i) => n + i.outstanding, 0))])) as Record<AgingBucket, number>;
  return { items: items.sort((a, b) => b.outstanding - a.outstanding), grid, totalsByBucket, total: round2(items.reduce((n, i) => n + i.outstanding, 0)) };
}

export type MarginRow = { key: string; jobs: number; revenue: number; subCost: number; labCost: number; otherCost: number; margin: number; marginPct: number | null };

/**
 * Revenue = the FreshBooks invoice amount when one exists, else the quoted amount. Jobs count in
 * the month they were Delivered (New York time). Lost/archived jobs are excluded.
 */
export async function margins(conn: Conn, range: { from: Date; to: Date }) {
  const rows = await conn
    .select({
      serviceCode: s.jobs.serviceCode,
      month: sql<string>`to_char(${s.jobs.deliveredAt} at time zone 'America/New_York', 'YYYY-MM')`,
      quoted: s.jobFinancials.quotedAmount,
      invoiced: s.invoicesCache.amount,
      sub: s.jobFinancials.subCost,
      lab: s.jobFinancials.labCost,
      other: s.jobFinancials.otherCost,
    })
    .from(s.jobs)
    .innerJoin(s.jobFinancials, eq(s.jobFinancials.jobId, s.jobs.id))
    .leftJoin(s.invoicesCache, eq(s.invoicesCache.freshbooksInvoiceId, s.jobFinancials.freshbooksInvoiceId))
    .where(
      and(
        isNull(s.jobs.archivedAt),
        isNotNull(s.jobs.deliveredAt),
        sql`${s.jobs.stage} <> 'LOST'`,
        sql`${s.jobs.deliveredAt} >= ${range.from.toISOString()} and ${s.jobs.deliveredAt} < ${range.to.toISOString()}`,
      ),
    );

  const roll = (keyOf: (r: (typeof rows)[number]) => string): MarginRow[] => {
    const acc = new Map<string, MarginRow>();
    for (const r of rows) {
      const key = keyOf(r);
      const m = acc.get(key) ?? { key, jobs: 0, revenue: 0, subCost: 0, labCost: 0, otherCost: 0, margin: 0, marginPct: null };
      const revenue = Number(r.invoiced ?? r.quoted ?? 0);
      m.jobs++;
      m.revenue = round2(m.revenue + revenue);
      m.subCost = round2(m.subCost + Number(r.sub ?? 0));
      m.labCost = round2(m.labCost + Number(r.lab ?? 0));
      m.otherCost = round2(m.otherCost + Number(r.other ?? 0));
      m.margin = round2(m.revenue - m.subCost - m.labCost - m.otherCost);
      m.marginPct = m.revenue ? Math.round((m.margin / m.revenue) * 1000) / 10 : null;
      acc.set(key, m);
    }
    return [...acc.values()];
  };
  const byService = roll((r) => r.serviceCode).sort((a, b) => b.revenue - a.revenue);
  const byMonth = roll((r) => r.month).sort((a, b) => a.key.localeCompare(b.key));
  const total = roll(() => "TOTAL")[0] ?? { key: "TOTAL", jobs: 0, revenue: 0, subCost: 0, labCost: 0, otherCost: 0, margin: 0, marginPct: null };
  return { byService, byMonth, total };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
