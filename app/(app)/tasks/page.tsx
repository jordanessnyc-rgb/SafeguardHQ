import Link from "next/link";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { TaskList } from "@/components/task-list";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";

export const metadata = { title: "Tasks" };

const FILTERS = { mine: "Mine", all: "Everyone", overdue: "Overdue", unassigned: "Unassigned" } as const;

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const filter = (Object.keys(FILTERS).includes(String(sp.filter)) ? sp.filter : "mine") as keyof typeof FILTERS;
  const tasks = await user.db((tx) =>
    tx
      .select({ t: s.tasks, jobNumber: s.jobs.jobNumber, address: s.properties.addressLine, caseId: s.airnycCases.caseId })
      .from(s.tasks)
      .leftJoin(s.jobs, eq(s.jobs.id, s.tasks.jobId))
      .leftJoin(s.properties, eq(s.properties.id, sql`coalesce(${s.tasks.propertyId}, ${s.jobs.propertyId})`))
      .leftJoin(s.airnycCases, eq(s.airnycCases.id, s.tasks.airnycCaseId))
      .where(
        and(
          isNull(s.tasks.archivedAt),
          inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]),
          filter === "mine" ? or(eq(s.tasks.assignee, user.id)) : undefined,
          filter === "unassigned" ? isNull(s.tasks.assignee) : undefined,
          filter === "overdue" ? lt(s.tasks.dueAt, new Date()) : undefined,
        ),
      )
      .orderBy(sql`${s.tasks.dueAt} asc nulls last`, asc(s.tasks.createdAt))
      .limit(300),
  );
  const withContext = tasks.map(({ t, jobNumber, address, caseId }) => ({
    ...t,
    description: [jobNumber && `Job ${jobNumber}`, caseId && `AIRnyc ${caseId}`, address].filter(Boolean).join(" · ") + (t.description ? `\n${t.description}` : "") || null,
  }));
  return (
    <>
      <PageHeader title="Tasks" description="Open tasks. System-created tasks (new violations, call next steps, deadlines, renewals) land here too." />
      <div className="mb-4 flex gap-1">
        {Object.entries(FILTERS).map(([k, v]) => (
          <Link key={k} href={`/tasks?filter=${k}`} className={buttonVariants({ size: "sm", variant: filter === k ? "secondary" : "ghost" })}>{v}</Link>
        ))}
      </div>
      <Card className="max-w-3xl">
        <CardContent>
          <TaskList tasks={withContext} link={{}} revalidate="/tasks" />
        </CardContent>
      </Card>
    </>
  );
}
