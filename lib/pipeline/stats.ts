/**
 * Won / lost numbers for the top of a pipeline board (Phase 7d). "Sales stages" are the ones before
 * Signed (Lead, Qualified, Proposal sent…). A job is *won* when it moves from a sales stage to a later
 * one, and *lost* when it's marked Lost. Jobs imported from FreshBooks history never pass through the
 * sales stages, so they don't count. Dollar figures come from job_financials, which RLS shows only to
 * the owner (a VA gets nulls, and the page doesn't show money to them anyway).
 */
import { sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import type { Pipeline } from "./config";

export function salesStages(p: Pick<Pipeline, "stages">): string[] {
  const ordered = [...p.stages].sort((a, b) => a.position - b.position);
  const signed = ordered.findIndex((st) => st.key === "SIGNED");
  return (signed >= 0 ? ordered.slice(0, signed) : []).filter((st) => !st.isTerminal).map((st) => st.key);
}

export type BoardStats = {
  won: number;
  wonValue: number | null;
  lost: number;
  topLossReason: string | null;
  winRate: number | null;
  decided90: number;
  openSales: number;
  openValue: number | null;
};

export async function boardStats(tx: Tx, pipeline: Pipeline): Promise<BoardStats | null> {
  const sales = salesStages(pipeline);
  if (!sales.length) return null;
  const salesArr = sql`array[${sql.join(sales.map((k) => sql`${k}`), sql`, `)}]::text[]`;
  const won = (days: number) => sql`
    select distinct a.job_id from ${s.activities} a join ${s.jobs} j on j.id = a.job_id
    where a.type = 'STAGE_CHANGE' and j.pipeline_key = ${pipeline.key} and j.archived_at is null
      and a.occurred_at > now() - make_interval(days => ${days})
      and a.raw->>'from' = any(${salesArr}) and a.raw->>'to' <> 'LOST' and not (a.raw->>'to' = any(${salesArr}))`;
  const lost = (days: number) => sql`
    select j.id from ${s.jobs} j where j.pipeline_key = ${pipeline.key} and j.archived_at is null and j.stage = 'LOST'
      and j.stage_entered_at > now() - make_interval(days => ${days})`;

  const { rows } = await tx.execute<{ won: number; won_value: string | null; lost: number; won90: number; lost90: number; open_sales: number; open_value: string | null; top_reason: string | null }>(sql`
    select
      (select count(*)::int from (${won(30)}) w) as won,
      (select sum(f.quoted_amount) from ${s.jobFinancials} f where f.job_id in (${won(30)})) as won_value,
      (select count(*)::int from (${lost(30)}) l) as lost,
      (select count(*)::int from (${won(90)}) w) as won90,
      (select count(*)::int from (${lost(90)}) l) as lost90,
      (select count(*)::int from ${s.jobs} j where j.pipeline_key = ${pipeline.key} and j.archived_at is null and j.stage = any(${salesArr})) as open_sales,
      (select sum(f.quoted_amount) from ${s.jobFinancials} f join ${s.jobs} j on j.id = f.job_id
        where j.pipeline_key = ${pipeline.key} and j.archived_at is null and j.stage = any(${salesArr})) as open_value,
      (select j.lost_reason from ${s.jobs} j where j.id in (${lost(90)}) and coalesce(j.lost_reason, '') <> ''
        group by j.lost_reason order by count(*) desc, j.lost_reason limit 1) as top_reason`);
  const r = rows[0];
  const decided = r.won90 + r.lost90;
  return {
    won: r.won,
    wonValue: r.won_value != null ? Number(r.won_value) : null,
    lost: r.lost,
    topLossReason: r.top_reason,
    winRate: decided ? Math.round((r.won90 / decided) * 100) : null,
    decided90: decided,
    openSales: r.open_sales,
    openValue: r.open_value != null ? Number(r.open_value) : null,
  };
}

export type WinLossRow = { key: string; leads: number; won: number; lost: number; open: number; winRate: number | null; avgDaysToWin: number | null };
export type WinLoss = { bySource: WinLossRow[]; byService: WinLossRow[]; total: WinLossRow; lossReasons: { reason: string; n: number }[] };

/**
 * Win/loss for leads that started in a sales stage in the last `days` (Reports page). Same rules as
 * the board: won = moved on from the sales stages, lost = marked Lost. Imported history never started
 * as a lead, so it's left out.
 */
export async function winLoss(tx: Tx, pipelines: Pipeline[], days = 365): Promise<WinLoss> {
  const sales = [...new Set(pipelines.flatMap((p) => salesStages(p)))];
  const empty: WinLoss = { bySource: [], byService: [], total: { key: "TOTAL", leads: 0, won: 0, lost: 0, open: 0, winRate: null, avgDaysToWin: null }, lossReasons: [] };
  if (!sales.length) return empty;
  const salesArr = sql`array[${sql.join(sales.map((k) => sql`${k}`), sql`, `)}]::text[]`;
  const { rows } = await tx.execute<{ source: string | null; service: string; stage: string; lost_reason: string | null; created_at: string; won_at: string | null }>(sql`
    select j.source, j.service_code as service, j.stage, j.lost_reason, j.created_at,
      (select min(a.occurred_at) from ${s.activities} a
        where a.job_id = j.id and a.type = 'STAGE_CHANGE' and a.raw->>'from' = any(${salesArr})
          and a.raw->>'to' <> 'LOST' and not (a.raw->>'to' = any(${salesArr}))) as won_at
    from ${s.jobs} j
    where j.archived_at is null and j.created_at > now() - make_interval(days => ${days})
      and exists (select 1 from ${s.activities} a0 where a0.job_id = j.id and a0.type = 'STAGE_CHANGE'
                  and a0.raw->>'from' is null and a0.raw->>'to' = any(${salesArr}))`);

  const roll = (keyOf: (r: (typeof rows)[number]) => string) => {
    const acc = new Map<string, WinLossRow & { daysSum: number }>();
    for (const r of rows) {
      const key = keyOf(r);
      const m = acc.get(key) ?? { key, leads: 0, won: 0, lost: 0, open: 0, winRate: null, avgDaysToWin: null, daysSum: 0 };
      m.leads++;
      if (r.won_at) {
        m.won++;
        m.daysSum += (new Date(r.won_at).getTime() - new Date(r.created_at).getTime()) / 86_400_000;
      } else if (r.stage === "LOST") m.lost++;
      else m.open++;
      acc.set(key, m);
    }
    return [...acc.values()]
      .map(({ daysSum, ...m }) => ({ ...m, winRate: m.won + m.lost ? Math.round((m.won / (m.won + m.lost)) * 100) : null, avgDaysToWin: m.won ? Math.round(daysSum / m.won) : null }))
      .sort((a, b) => b.leads - a.leads);
  };
  const reasons = new Map<string, number>();
  for (const r of rows) if (r.stage === "LOST") reasons.set(r.lost_reason?.trim() || "No reason given", (reasons.get(r.lost_reason?.trim() || "No reason given") ?? 0) + 1);
  return {
    bySource: roll((r) => r.source ?? "UNKNOWN"),
    byService: roll((r) => r.service),
    total: roll(() => "TOTAL")[0] ?? empty.total,
    lossReasons: [...reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  };
}
