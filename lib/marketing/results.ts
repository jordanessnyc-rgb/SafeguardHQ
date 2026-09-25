/**
 * Campaign results (SPEC §11). Counts are visible to staff; revenue and cost come from OWNER-only
 * tables, so under a VA's RLS they are simply empty (never computed from anything a VA can read).
 */
import { sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";

export type CampaignResult = {
  id: string;
  scans: number;
  leads: number;
  jobs: number;
  won: number;
  revenue: number | null;
  cost: number | null;
};

const WON_STAGES = ["SIGNED", "SCHEDULED", "FIELD_COMPLETE", "LAB_PENDING", "DRAFTING", "QA", "DELIVERED", "INVOICED", "PAID", "CLOSED", "NEXT_CYCLE_SCHEDULED"];

export async function campaignResults(conn: Db | Tx): Promise<Map<string, CampaignResult>> {
  const rows = await conn.execute<{ id: string; scans: number; leads: number; jobs: number; won: number; revenue: string | null; cost: string | null }>(sql`
    select c.id,
      (select count(*)::int from ${s.campaignEvents} e where e.campaign_id = c.id and e.kind = 'SCAN') as scans,
      (select count(*)::int from ${s.contacts} ct where ct.campaign_id = c.id and ct.archived_at is null) as leads,
      (select count(*)::int from ${s.jobs} j where j.campaign_id = c.id and j.archived_at is null) as jobs,
      (select count(*)::int from ${s.jobs} j where j.campaign_id = c.id and j.archived_at is null and j.stage in (${sql.join(WON_STAGES.map((w) => sql`${w}`), sql`, `)})) as won,
      (select sum(coalesce(i.amount, f.quoted_amount)) from ${s.jobs} j
         join ${s.jobFinancials} f on f.job_id = j.id
         left join ${s.invoicesCache} i on i.freshbooks_invoice_id = f.freshbooks_invoice_id
        where j.campaign_id = c.id and j.archived_at is null and j.stage in (${sql.join(WON_STAGES.map((w) => sql`${w}`), sql`, `)})) as revenue,
      (select cc.cost from ${s.campaignCosts} cc where cc.campaign_id = c.id) as cost
    from ${s.campaigns} c where c.archived_at is null`);
  return new Map(
    rows.rows.map((r) => [r.id, { id: r.id, scans: r.scans, leads: r.leads, jobs: r.jobs, won: r.won, revenue: r.revenue == null ? null : Number(r.revenue), cost: r.cost == null ? null : Number(r.cost) }]),
  );
}
