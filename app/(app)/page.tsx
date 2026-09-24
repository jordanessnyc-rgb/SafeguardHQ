import Link from "next/link";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { TaskList } from "@/components/task-list";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { loadPipelines } from "@/lib/pipeline/config";
import { daysInStage, isStale } from "@/lib/pipeline/rules";

export default async function Dashboard() {
  const user = await requireStaff();
  const d = await user.db(async (tx) => {
    const pipelines = await loadPipelines(tx);
    const terminal = pipelines.flatMap((p) => p.stages.filter((st) => st.isTerminal).map((st) => st.key));
    const openJobs = await tx
      .select({ job: s.jobs, address: s.properties.addressLine })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(isNull(s.jobs.archivedAt), notInArray(s.jobs.stage, terminal)));
    const myTasks = await tx
      .select()
      .from(s.tasks)
      .where(and(isNull(s.tasks.archivedAt), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]), or(eq(s.tasks.assignee, user.id), isNull(s.tasks.assignee))))
      .orderBy(sql`${s.tasks.dueAt} asc nulls last`, asc(s.tasks.createdAt))
      .limit(12);
    const [{ openCases }] = await tx
      .select({ openCases: sql<number>`count(*)::int` })
      .from(s.airnycCases)
      .where(and(isNull(s.airnycCases.archivedAt), notInArray(s.airnycCases.stage, ["PAID", "LOST"])));
    return { pipelines, openJobs, myTasks, openCases };
  });

  const stageInfo = new Map(d.pipelines.flatMap((p) => p.stages.map((st) => [`${p.key}:${st.key}`, st] as const)));
  const stale = d.openJobs
    .filter(({ job }) => isStale(job.stageEnteredAt, stageInfo.get(`${job.pipelineKey}:${job.stage}`)?.staleAfterDays ?? null))
    .sort((a, b) => a.job.stageEnteredAt.getTime() - b.job.stageEnteredAt.getTime());
  const count = (stage: string) => d.openJobs.filter(({ job }) => job.stage === stage).length;

  return (
    <>
      <PageHeader
        title={`Hi${user.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}`}
        actions={
          <>
            <Link href="/properties/new" className={buttonVariants({ variant: "outline" })}>New property</Link>
            <Link href="/jobs/new" className={buttonVariants()}>New job</Link>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Open jobs", d.openJobs.length, "/jobs?view=list"],
          ["Leads", count("LEAD") + count("QUALIFIED"), "/jobs"],
          ["Lab pending", count("LAB_PENDING"), "/jobs"],
          ["Stale", stale.length, "/jobs?view=list"],
          ["AIRnyc open", d.openCases, "/airnyc"],
        ].map(([k, v, href]) => (
          <Link key={k} href={String(href)} className="rounded-lg border p-3 hover:border-primary">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="text-2xl font-semibold">{v}</div>
          </Link>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>My tasks</CardTitle></CardHeader>
          <CardContent><TaskList tasks={d.myTasks} link={{}} revalidate="/" /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Stale jobs</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {stale.length === 0 && <p className="text-muted-foreground">Nothing is stuck. 👍</p>}
            {stale.slice(0, 15).map(({ job, address }) => (
              <Link key={job.id} href={`/jobs/${job.id}`} className="flex items-center justify-between gap-2 rounded-md border p-2 hover:bg-muted">
                <span className="min-w-0">
                  <span className="font-mono text-xs">{job.jobNumber}</span> {label(SERVICE_LABELS, job.serviceCode)}
                  {address && <span className="block truncate text-xs text-muted-foreground">{address}</span>}
                </span>
                <Badge variant="destructive">
                  {stageInfo.get(`${job.pipelineKey}:${job.stage}`)?.name} · {daysInStage(job.stageEnteredAt)}d
                </Badge>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
