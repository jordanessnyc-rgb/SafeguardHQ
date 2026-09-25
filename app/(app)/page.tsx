import Link from "next/link";
import { and, count, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import { Check } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/page-header";
import { setTaskStatus } from "@/app/(app)/tasks/actions";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { buildNeedsYou, type NeedsKind } from "@/lib/dashboard/needs-you";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { loadPipelines } from "@/lib/pipeline/config";
import { isStale } from "@/lib/pipeline/rules";
import { nyDate, TZ } from "@/lib/time";
import { cn } from "@/lib/utils";

const KIND: Record<NeedsKind, { label: string; className: string }> = {
  approve: { label: "Approve", className: "bg-sidebar-accent text-sidebar-primary" },
  file: { label: "File", className: "bg-sidebar-accent text-sidebar-primary" },
  task: { label: "Task", className: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200" },
  stale: { label: "Stale", className: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  lab: { label: "Lab", className: "bg-muted text-foreground" },
  invoice: { label: "Invoice", className: "bg-purple-50 text-purple-900 dark:bg-purple-950 dark:text-purple-200" },
  expiring: { label: "Expiring", className: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  compliance: { label: "Compliance", className: "bg-muted text-foreground" },
  bid: { label: "Bid", className: "bg-muted text-foreground" },
};

const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "—");

export default async function Dashboard() {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const today = nyDate(new Date());
  const d = await user.db(async (tx) => {
    const pipelines = await loadPipelines(tx);
    const terminal = pipelines.flatMap((p) => p.stages.filter((st) => st.isTerminal).map((st) => st.key));
    const openJobs = await tx
      .select({ stage: s.jobs.stage, pipelineKey: s.jobs.pipelineKey, stageEnteredAt: s.jobs.stageEnteredAt })
      .from(s.jobs)
      .where(and(isNull(s.jobs.archivedAt), notInArray(s.jobs.stage, terminal)));
    const [{ openCases }] = await tx
      .select({ openCases: count() })
      .from(s.airnycCases)
      .where(and(isNull(s.airnycCases.archivedAt), notInArray(s.airnycCases.stage, ["PAID", "LOST"])));
    const stops = await tx
      .select({ id: s.jobs.id, jobNumber: s.jobs.jobNumber, serviceCode: s.jobs.serviceCode, scheduledAt: s.jobs.scheduledAt, address: s.properties.addressLine, borough: s.properties.borough })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(isNull(s.jobs.archivedAt), ne(s.jobs.stage, "LOST"), sql`(${s.jobs.scheduledAt} at time zone ${TZ})::date = ${today}::date`))
      .orderBy(s.jobs.scheduledAt);
    const needs = await buildNeedsYou(tx, { userId: user.id, isOwner });
    return { pipelines, openJobs, openCases, stops, needs };
  });

  const stageInfo = new Map(d.pipelines.flatMap((p) => p.stages.map((st) => [`${p.key}:${st.key}`, st] as const)));
  const staleCount = d.openJobs.filter((j) => isStale(j.stageEnteredAt, stageInfo.get(`${j.pipelineKey}:${j.stage}`)?.staleAfterDays ?? null)).length;
  const count_ = (...stages: string[]) => d.openJobs.filter((j) => stages.includes(j.stage)).length;

  // "Pipeline at a glance": the main inspection pipeline's open stages, with stale ones marked.
  const main = d.pipelines.find((p) => p.key !== "AIRNYC");
  const bars = (main?.stages ?? [])
    .filter((st) => !st.isTerminal)
    .map((st) => {
      const jobs = d.openJobs.filter((j) => j.pipelineKey === main!.key && j.stage === st.key);
      return { key: st.key, name: st.name, n: jobs.length, stale: jobs.some((j) => isStale(j.stageEnteredAt, st.staleAfterDays)) };
    });
  const maxBar = Math.max(1, ...bars.map((b) => b.n));

  const hour = Number(new Date().toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false }));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = user.fullName?.split(" ")[0];

  const tiles = [
    { k: "Open jobs", v: d.openJobs.length, href: "/jobs?view=list", link: "All open jobs" },
    { k: "Leads", v: count_("LEAD", "QUALIFIED"), href: "/jobs?view=list&stage=LEAD,QUALIFIED", link: "Lead + Qualified" },
    { k: "Lab pending", v: count_("LAB_PENDING"), href: "/jobs?view=list&stage=LAB_PENDING", link: "Waiting on the lab" },
    { k: "Stale", v: staleCount, href: "/jobs?view=list&stale=1&sort=days", link: "Past their limit", warn: staleCount > 0 },
    { k: "AIRnyc open", v: d.openCases, href: "/airnyc", link: "Open cases" },
  ];

  return (
    <>
      <PageHeader
        title={`${greeting}${first ? `, ${first}` : ""}`}
        description={new Date().toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" })}
        actions={
          <>
            <Link href="/properties/new" className={buttonVariants({ variant: "outline" })}>New property</Link>
            <Link href="/jobs/new" className={buttonVariants()}>New job</Link>
          </>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="group rounded-lg border bg-card p-3 hover:border-primary">
            <div className="text-xs text-muted-foreground">{t.k}</div>
            <div className={cn("text-2xl font-semibold tabular-nums", t.warn && "text-amber-700 dark:text-amber-400")}>{t.v}</div>
            <div className="text-xs font-medium text-primary group-hover:underline">{t.link} →</div>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>Needs you</CardTitle>
            <p className="text-xs text-muted-foreground">Most urgent first · each row has one next step</p>
          </CardHeader>
          <CardContent className="px-0">
            {d.needs.length === 0 ? (
              <div className="p-4">
                <EmptyState>Nothing is waiting on you. Nice.</EmptyState>
              </div>
            ) : (
              <ul className="divide-y">
                {d.needs.map((n) => (
                  <li key={n.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:flex-nowrap">
                    <span className={cn("w-22 shrink-0 rounded px-2 py-0.5 text-center text-[11px] font-semibold", KIND[n.kind].className)}>{KIND[n.kind].label}</span>
                    <Link href={n.href} className="min-w-0 flex-1 hover:underline">
                      <span className="block truncate text-sm font-medium">{n.title}</span>
                      {n.meta && <span className="block truncate text-xs text-muted-foreground">{n.meta}</span>}
                    </Link>
                    {n.when && <span className={cn("text-xs whitespace-nowrap", n.late ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>{n.when}</span>}
                    {n.taskId ? (
                      <form action={setTaskStatus.bind(null, n.taskId, "DONE", "/")}>
                        <Button type="submit" size="sm" variant="outline" aria-label={`Mark “${n.title}” done`}>
                          <Check /> Done
                        </Button>
                      </form>
                    ) : (
                      <Link href={n.href} className={buttonVariants({ size: "sm", variant: "outline" })}>{n.action}</Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Today&apos;s route</CardTitle>
              <Link href="/route" className="text-sm font-medium text-primary hover:underline">Open route</Link>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              {d.stops.length === 0 && <p className="text-muted-foreground">Nothing scheduled today.</p>}
              {d.stops.map((st) => (
                <Link key={st.id} href={`/jobs/${st.id}`} className="flex gap-3 rounded-md hover:bg-muted">
                  <span className="w-16 shrink-0 font-mono text-xs leading-5 font-medium text-primary">{time(st.scheduledAt)}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{st.address ?? "No address"}{st.borough ? ` · ${st.borough}` : ""}</span>
                    <span className="block truncate text-xs text-muted-foreground">{label(SERVICE_LABELS, st.serviceCode)} · {st.jobNumber}</span>
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>

          {main && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{main.name}</CardTitle>
                <Link href={`/jobs?pipeline=${main.key}`} className="text-sm font-medium text-primary hover:underline">Board</Link>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {bars.map((b) => (
                  <Link key={b.key} href={`/jobs?view=list&stage=${b.key}`} className="flex items-center gap-2 hover:underline" aria-label={`${b.name}: ${b.n} jobs${b.stale ? ", some stale" : ""}`}>
                    <span className="w-28 shrink-0 truncate">{b.name}</span>
                    <span className="h-2 flex-1 rounded-full bg-muted">
                      <span className={cn("block h-2 rounded-full", b.stale ? "bg-amber-500" : "bg-(--brand-sage)")} style={{ width: `${(b.n / maxBar) * 100}%` }} />
                    </span>
                    <span className="w-6 text-right font-semibold tabular-nums">{b.n}</span>
                  </Link>
                ))}
                <p className="pt-1 text-muted-foreground">Amber = at least one job past its stale limit.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
