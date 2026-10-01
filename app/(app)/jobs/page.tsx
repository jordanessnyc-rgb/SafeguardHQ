import Link from "next/link";
import { and, desc, eq, gt, ilike, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FilterForm } from "@/components/filter-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { PAGE_SIZE, pageFrom, pageWindow } from "@/lib/list";
import { jobsHref, jobsView } from "@/lib/jobs/list-state";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, personName, SERVICE_LABELS, usd } from "@/lib/labels";
import { col } from "@/lib/db/sql";
import { boardStats } from "@/lib/pipeline/stats";
import { loadPipelines } from "@/lib/pipeline/config";
import { daysInStage, isStale } from "@/lib/pipeline/rules";
import { cn } from "@/lib/utils";
import { Kanban, type BoardJob } from "./kanban";

export const metadata = { title: "Jobs" };

const SORTS = [
  ["newest", "Newest first"],
  ["days", "Longest in stage"],
  ["number", "Job number"],
  ["stage", "Stage order"],
] as const;
const BOARD_SORTS = [
  ["newest", "Newest first"],
  ["days", "Longest in stage"],
  ["quiet", "Longest since contact"],
  ["value", "Highest value"],
] as const;
const STATUSES = [
  ["open", "Open jobs"],
  ["closed", "Closed & past jobs"],
  ["all", "All jobs"],
] as const;
/** Closed/Lost cards stay on the board this long, so the board isn't buried under years of history. */
const BOARD_TERMINAL_DAYS = 30;

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");
  const q = str(sp.q);
  // Jobs opens as a list; Board is an explicit choice.
  const stageFilter = str(sp.stage).split(",").filter(Boolean);
  const service = s.jobs.serviceCode.enumValues.find((v) => v === str(sp.service)) ?? "";
  const staleOnly = sp.stale === "1";
  const status = STATUSES.find(([k]) => k === sp.status)?.[0] ?? "open";
  const sort = SORTS.some(([k]) => k === sp.sort) ? String(sp.sort) : "newest";
  const view = jobsView(sp);
  const mine = sp.mine === "1";
  const bsort = BOARD_SORTS.find(([k]) => k === sp.bsort)?.[0] ?? "newest";
  const isOwner = user.role === "OWNER";

  const { pipelines, rows, stats } = await user.db(async (tx) => {
    const pipelines = (await loadPipelines(tx)).filter((p) => p.key !== "AIRNYC");
    const pipelineKey = pipelines.find((p) => p.key === sp.pipeline)?.key ?? pipelines[0]?.key;
    const terminal = [...new Set(pipelines.flatMap((p) => p.stages.filter((st) => st.isTerminal).map((st) => st.key)))];
    const jobId = col(s.jobs.id);
    const rows = await tx
      .select({
        job: s.jobs,
        address: s.properties.addressLine,
        unit: s.properties.unit,
        orgName: s.organizations.name,
        contact: { firstName: s.contacts.firstName, lastName: s.contacts.lastName },
        // Owner only: job_financials is invisible to a VA under RLS, so this is null for them.
        value: s.jobFinancials.quotedAmount,
        lastTouch: sql<string | null>`(select max(a.occurred_at) from ${s.activities} a where a.job_id = ${jobId} and a.type <> 'STAGE_CHANGE')`,
        touches: sql<number>`(select count(*)::int from ${s.activities} a where a.job_id = ${jobId} and a.direction = 'OUTBOUND')`,
        nextTask: sql<string | null>`(select t.title || '|' || coalesce(to_char(t.due_at at time zone 'America/New_York', 'Mon DD'), '') from ${s.tasks} t where t.job_id = ${jobId} and t.status in ('OPEN', 'IN_PROGRESS') and t.archived_at is null order by t.due_at nulls last limit 1)`,
      })
      .from(s.jobs)
      .leftJoin(s.jobFinancials, eq(s.jobFinancials.jobId, s.jobs.id))
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
      .where(
        and(
          isNull(s.jobs.archivedAt),
          mine ? eq(s.jobs.assignedTo, user.id) : undefined,
          view === "board" ? eq(s.jobs.pipelineKey, pipelineKey) : undefined,
          view === "board" && terminal.length
            ? or(notInArray(s.jobs.stage, terminal), gt(s.jobs.stageEnteredAt, sql`now() - make_interval(days => ${BOARD_TERMINAL_DAYS})`))
            : undefined,
          view === "list" && status === "open" && terminal.length && !stageFilter.length ? notInArray(s.jobs.stage, terminal) : undefined,
          view === "list" && status === "closed" && terminal.length && !stageFilter.length ? inArray(s.jobs.stage, terminal) : undefined,
          view === "list" && stageFilter.length ? inArray(s.jobs.stage, stageFilter) : undefined,
          view === "list" && service ? eq(s.jobs.serviceCode, service) : undefined,
          q
            ? or(
                ilike(s.jobs.jobNumber, `%${q}%`),
                ilike(s.properties.addressLine, `%${q}%`),
                ilike(s.organizations.name, `%${q}%`),
                ilike(sql`coalesce(${s.contacts.firstName}, '') || ' ' || coalesce(${s.contacts.lastName}, '')`, `%${q}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(s.jobs.createdAt))
      .limit(5000);
    const stats = view === "board" && pipelineKey ? await boardStats(tx, pipelines.find((p) => p.key === pipelineKey)!) : null;
    return { pipelines, rows, pipelineKey, stats };
  });
  const pipelineKey = pipelines.find((p) => p.key === sp.pipeline)?.key ?? pipelines[0]?.key;
  const pipeline = pipelines.find((p) => p.key === pipelineKey)!;
  const stageByKey = new Map(pipelines.flatMap((p) => p.stages.map((st) => [`${p.key}:${st.key}`, st] as const)));

  const toCard = ({ job, address, unit, orgName, contact, value, lastTouch, touches, nextTask }: (typeof rows)[number]): BoardJob => {
    const st = stageByKey.get(`${job.pipelineKey}:${job.stage}`);
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      stage: job.stage,
      service: label(SERVICE_LABELS, job.serviceCode),
      address: address ? `${address}${unit ? ` #${unit}` : ""}` : null,
      client: orgName ?? (contact?.lastName || contact?.firstName ? personName(contact!) : null),
      daysInStage: daysInStage(job.stageEnteredAt),
      stale: !st?.isTerminal && isStale(job.stageEnteredAt, st?.staleAfterDays ?? null),
      priority: job.priority,
      value: value != null ? Number(value) : null,
      lastTouchDays: lastTouch ? daysInStage(new Date(lastTouch)) : null,
      touches,
      nextTask: nextTask ? { title: nextTask.split("|")[0], due: nextTask.split("|")[1] || null } : null,
    };
  };

  const boardCards = view === "board" ? rows.map(toCard) : [];
  if (bsort === "days") boardCards.sort((a, b) => b.daysInStage - a.daysInStage);
  else if (bsort === "quiet") boardCards.sort((a, b) => (b.lastTouchDays ?? b.daysInStage) - (a.lastTouchDays ?? a.daysInStage));
  else if (bsort === "value") boardCards.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const listParams = { stage: stageFilter.join(",") || undefined, service: service || undefined, stale: staleOnly ? "1" : undefined, status: status === "open" ? undefined : status, sort: sort === "newest" ? undefined : sort };
  const qs = (o: Record<string, string | undefined>) => {
    return jobsHref({ view, pipeline: pipelineKey, q: q || undefined, mine: mine ? "1" : undefined, bsort: view === "board" && bsort !== "newest" ? bsort : undefined, ...(view === "list" ? listParams : {}) }, o);
  };

  const stageOptions = [...new Map(pipelines.flatMap((p) => p.stages.map((st) => [st.key, st] as const))).values()].sort((a, b) => a.position - b.position);
  const stageRank = new Map(stageOptions.map((st, i) => [st.key, i]));
  const listRows = view === "list" ? rows.map((r) => ({ r, c: toCard(r) })).filter(({ c }) => !staleOnly || c.stale) : [];
  if (sort === "days") listRows.sort((a, b) => b.c.daysInStage - a.c.daysInStage);
  else if (sort === "number") listRows.sort((a, b) => a.c.jobNumber.localeCompare(b.c.jobNumber));
  else if (sort === "stage") listRows.sort((a, b) => (stageRank.get(a.c.stage) ?? 99) - (stageRank.get(b.c.stage) ?? 99));
  const filtered = Boolean(stageFilter.length || service || staleOnly || q || mine || status !== "open");
  const win = pageWindow(listRows.length, pageFrom(sp.page));
  const pageRows = listRows.slice(win.offset, win.offset + PAGE_SIZE);
  const pageHref = (page: number) => qs({ view: "list", page: String(page) });
  const openOnBoard = view === "board" ? rows.filter((r) => !stageByKey.get(`${r.job.pipelineKey}:${r.job.stage}`)?.isTerminal).length : 0;

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Find a job by address or client, then see what needs to happen next."
        actions={
          <>
            <div className="flex rounded-lg border p-0.5">
              <Link href={qs({ view: "board", stage: undefined, service: undefined, stale: undefined, sort: undefined })} className={buttonVariants({ size: "sm", variant: view === "board" ? "secondary" : "ghost" })}>Board</Link>
              <Link href={qs({ view: "list" })} className={buttonVariants({ size: "sm", variant: view === "list" ? "secondary" : "ghost" })}>List</Link>
            </div>
            <Link href="/jobs/new" className={buttonVariants()}>New job</Link>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {view === "board" &&
          pipelines.map((p) => (
            <Link key={p.key} href={qs({ pipeline: p.key })} className={cn(buttonVariants({ size: "sm", variant: p.key === pipelineKey ? "default" : "outline" }))}>
              {p.name}
            </Link>
          ))}
        <FilterForm action="/jobs" className={view === "board" ? "ml-auto w-full sm:w-auto" : "w-full"}>
          <input type="hidden" name="view" value={view} />
          <label className="flex h-8 items-center gap-2 rounded-lg border px-2.5 text-sm">
            <input type="checkbox" name="mine" value="1" defaultChecked={mine} className="size-4 accent-primary" />
            Mine
          </label>
          {view === "board" && (
            <NativeSelect name="bsort" defaultValue={bsort} aria-label="Sort cards by" className="w-auto">
              {BOARD_SORTS.filter(([k]) => isOwner || k !== "value").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </NativeSelect>
          )}
          {view === "board" && <input type="hidden" name="pipeline" value={pipelineKey} />}
          <Input type="search" name="q" defaultValue={q} placeholder="Search job #, address, client" aria-label="Search jobs" className="w-full sm:w-64" />
          {view === "list" && (
            <>
              <NativeSelect name="status" defaultValue={status} aria-label="Open or closed" className="w-auto">
                {STATUSES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
              <NativeSelect name="stage" defaultValue={stageFilter.join(",")} aria-label="Stage" className="w-auto">
                <option value="">All stages</option>
                {stageFilter.length > 1 && <option value={stageFilter.join(",")}>{stageFilter.map((k) => stageOptions.find((st) => st.key === k)?.name ?? k).join(" + ")}</option>}
                {stageOptions.map((st) => <option key={st.key} value={st.key}>{st.name}</option>)}
              </NativeSelect>
              <NativeSelect name="service" defaultValue={service} aria-label="Service" className="w-auto">
                <option value="">All services</option>
                {Object.entries(SERVICE_LABELS).filter(([k]) => k !== "AIRNYC").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
              <label className="flex h-8 items-center gap-2 rounded-lg border px-2.5 text-sm">
                <input type="checkbox" name="stale" value="1" defaultChecked={staleOnly} className="size-4 accent-primary" />
                Stale only
              </label>
              <NativeSelect name="sort" defaultValue={sort} aria-label="Sort by" className="w-auto">
                {SORTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
              {filtered && <Link href="/jobs?view=list" className="text-sm text-muted-foreground underline hover:text-foreground">Clear filters</Link>}
            </>
          )}
        </FilterForm>
      </div>

      {view === "board" ? (
        <>
          {openOnBoard === 0 && (
            <div className="mb-3">
              <EmptyState>
                No open jobs in {pipeline.name}{q ? " match that search" : ""}. <Link href="/jobs/new" className="font-medium text-primary underline">Start a new job</Link>
                {" "}or see <Link href="/jobs?view=list&status=closed" className="underline">past jobs</Link>.
              </EmptyState>
            </div>
          )}
          {stats && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Won · last 30 days" value={String(stats.won)} sub={isOwner && stats.wonValue ? usd(stats.wonValue, false) : undefined} tone="good" />
              <Stat label="Lost · last 30 days" value={String(stats.lost)} sub={stats.topLossReason ? `Top reason: ${stats.topLossReason}` : undefined} />
              <Stat label="Win rate · 90 days" value={stats.winRate === null ? "—" : `${stats.winRate}%`} sub={`${stats.decided90} decided`} />
              <Stat label="Open in sales stages" value={String(stats.openSales)} sub={isOwner && stats.openValue ? `${usd(stats.openValue, false)} quoted` : undefined} />
            </div>
          )}
          <Kanban
            columns={pipeline.stages.map(({ key, name, isTerminal }) => ({ key, name: isTerminal ? `${name} · last ${BOARD_TERMINAL_DAYS} days` : name, isTerminal }))}
            jobs={boardCards}
            showValue={isOwner}
          />
        </>
      ) : listRows.length === 0 ? (
        <EmptyState>No jobs match{filtered ? " these filters" : ""}.</EmptyState>
      ) : (
        <>
        <Pager total={win.pages ? listRows.length : 0} {...win} href={pageHref} noun={listRows.length === 1 ? "job" : "jobs"} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job & property</TableHead>
              <TableHead className="hidden sm:table-cell">Client</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="hidden lg:table-cell">Next task</TableHead>
              <TableHead className="text-right">Days in stage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map(({ r, c }) => {
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`/jobs/${c.id}`} className="block font-medium hover:underline">{c.address ?? c.jobNumber}</Link>
                    <div className="text-xs text-muted-foreground">{c.service} · {c.jobNumber}</div>
                    <div className="mt-1 text-xs sm:hidden">{c.client ?? "No client linked"}</div>
                    {c.nextTask && <div className="mt-1 text-xs lg:hidden">Next: {c.nextTask.title}</div>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{c.client ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={c.stale ? "destructive" : "secondary"}>{stageByKey.get(`${r.job.pipelineKey}:${r.job.stage}`)?.name ?? r.job.stage}</Badge>
                  </TableCell>
                  <TableCell className="hidden max-w-64 lg:table-cell">{c.nextTask ? <><div className="truncate text-sm">{c.nextTask.title}</div><div className="text-xs text-muted-foreground">{c.nextTask.due ?? "No due date"}</div></> : <span className="text-xs text-muted-foreground">No task set</span>}</TableCell>
                  <TableCell className="text-right">{c.daysInStage}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Pager total={listRows.length} {...win} href={pageHref} noun="jobs" className="justify-end [&>span:first-child]:hidden" />
        </>
      )}
    </>
  );
}

function Stat({ label: title, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{title}</div>
      <div className={cn("text-lg font-semibold tabular-nums", tone === "good" && "text-primary")}>{value}</div>
      {sub && <div className="truncate text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
