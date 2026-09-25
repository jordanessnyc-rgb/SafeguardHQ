import Link from "next/link";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FilterForm } from "@/components/filter-form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
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

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");
  const q = str(sp.q);
  // Filters are list-only; a link that carries one (e.g. from a dashboard tile) opens the list.
  const stageFilter = str(sp.stage).split(",").filter(Boolean);
  const service = s.jobs.serviceCode.enumValues.find((v) => v === str(sp.service)) ?? "";
  const staleOnly = sp.stale === "1";
  const sort = SORTS.some(([k]) => k === sp.sort) ? String(sp.sort) : "newest";
  const view = sp.view === "list" || stageFilter.length || service || staleOnly ? "list" : "board";

  const { pipelines, rows } = await user.db(async (tx) => {
    const pipelines = (await loadPipelines(tx)).filter((p) => p.key !== "AIRNYC");
    const pipelineKey = pipelines.find((p) => p.key === sp.pipeline)?.key ?? pipelines[0]?.key;
    const rows = await tx
      .select({ job: s.jobs, address: s.properties.addressLine, unit: s.properties.unit, orgName: s.organizations.name, contact: { firstName: s.contacts.firstName, lastName: s.contacts.lastName } })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
      .where(
        and(
          isNull(s.jobs.archivedAt),
          view === "board" ? eq(s.jobs.pipelineKey, pipelineKey) : undefined,
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
      .limit(500);
    return { pipelines, rows, pipelineKey };
  });
  const pipelineKey = pipelines.find((p) => p.key === sp.pipeline)?.key ?? pipelines[0]?.key;
  const pipeline = pipelines.find((p) => p.key === pipelineKey)!;
  const stageByKey = new Map(pipelines.flatMap((p) => p.stages.map((st) => [`${p.key}:${st.key}`, st] as const)));

  const toCard = ({ job, address, unit, orgName, contact }: (typeof rows)[number]): BoardJob => {
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
    };
  };

  const listParams = { stage: stageFilter.join(",") || undefined, service: service || undefined, stale: staleOnly ? "1" : undefined, sort: sort === "newest" ? undefined : sort };
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { view, pipeline: pipelineKey, q: q || undefined, ...(view === "list" ? listParams : {}), ...o };
    Object.entries(merged).forEach(([k, v]) => v && p.set(k, v));
    return `/jobs?${p}`;
  };

  const stageOptions = [...new Map(pipelines.flatMap((p) => p.stages.map((st) => [st.key, st] as const))).values()].sort((a, b) => a.position - b.position);
  const stageRank = new Map(stageOptions.map((st, i) => [st.key, i]));
  const listRows = view === "list" ? rows.map((r) => ({ r, c: toCard(r) })).filter(({ c }) => !staleOnly || c.stale) : [];
  if (sort === "days") listRows.sort((a, b) => b.c.daysInStage - a.c.daysInStage);
  else if (sort === "number") listRows.sort((a, b) => a.c.jobNumber.localeCompare(b.c.jobNumber));
  else if (sort === "stage") listRows.sort((a, b) => (stageRank.get(a.c.stage) ?? 99) - (stageRank.get(b.c.stage) ?? 99));
  const filtered = Boolean(stageFilter.length || service || staleOnly || q);

  return (
    <>
      <PageHeader
        title="Jobs"
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
          {view === "board" && <input type="hidden" name="pipeline" value={pipelineKey} />}
          <Input type="search" name="q" defaultValue={q} placeholder="Search job #, address, client" aria-label="Search jobs" className="w-full sm:w-64" />
          {view === "list" && (
            <>
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
        <Kanban columns={pipeline.stages.map(({ key, name, isTerminal }) => ({ key, name, isTerminal }))} jobs={rows.map(toCard)} />
      ) : listRows.length === 0 ? (
        <EmptyState>No jobs match{filtered ? " these filters" : ""}.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead className="hidden md:table-cell">Property</TableHead>
              <TableHead className="hidden sm:table-cell">Client</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Days</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listRows.map(({ r, c }) => {
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`/jobs/${c.id}`} className="font-mono text-xs hover:underline">{c.jobNumber}</Link>
                    <div className="text-xs">{c.service}</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{c.address ?? "—"}</TableCell>
                  <TableCell className="hidden sm:table-cell">{c.client ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={c.stale ? "destructive" : "secondary"}>{stageByKey.get(`${r.job.pipelineKey}:${r.job.stage}`)?.name ?? r.job.stage}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{c.daysInStage}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </>
  );
}
