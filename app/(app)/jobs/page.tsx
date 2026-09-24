import Link from "next/link";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const view = sp.view === "list" ? "list" : "board";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";

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

  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { view, pipeline: pipelineKey, q: q || undefined, ...o };
    Object.entries(merged).forEach(([k, v]) => v && p.set(k, v));
    return `/jobs?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Jobs"
        actions={
          <>
            <div className="flex rounded-lg border p-0.5">
              <Link href={qs({ view: "board" })} className={buttonVariants({ size: "sm", variant: view === "board" ? "secondary" : "ghost" })}>Board</Link>
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
        <form className="ml-auto w-full max-w-xs sm:w-auto">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="pipeline" value={pipelineKey} />
          <Input name="q" defaultValue={q} placeholder="Search job #, address, client" />
        </form>
      </div>

      {view === "board" ? (
        <Kanban columns={pipeline.stages.map(({ key, name, isTerminal }) => ({ key, name, isTerminal }))} jobs={rows.map(toCard)} />
      ) : rows.length === 0 ? (
        <EmptyState>No jobs match.</EmptyState>
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
            {rows.map((r) => {
              const c = toCard(r);
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
