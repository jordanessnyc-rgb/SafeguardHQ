import Link from "next/link";
import { desc, gte, sql } from "drizzle-orm";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { workflowDefinition } from "@/lib/automation/engine";
import { describeSteps, describeTrigger, editorOptions } from "@/lib/automation/describe";

export const metadata = { title: "Automations" };

/** Every workflow: what starts it, what it does, whether it's on, and how often it ran lately. */
export default async function AutomationsPage() {
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const { workflows, options, counts } = await user.db(async (tx) => {
    const counts = await tx
      .select({
        workflowId: s.workflowRuns.workflowId,
        done: sql<number>`count(*) filter (where ${s.workflowRuns.status} = 'DONE')::int`,
        running: sql<number>`count(*) filter (where ${s.workflowRuns.status} in ('RUNNING', 'WAITING'))::int`,
        failed: sql<number>`count(*) filter (where ${s.workflowRuns.status} = 'FAILED')::int`,
      })
      .from(s.workflowRuns)
      .where(gte(s.workflowRuns.createdAt, sql`now() - interval '30 days'`))
      .groupBy(s.workflowRuns.workflowId);
    return {
      workflows: await tx.select().from(s.workflows).where(sql`${s.workflows.archivedAt} is null`).orderBy(desc(s.workflows.active), desc(s.workflows.updatedAt)),
      options: await editorOptions(tx),
      counts: new Map(counts.map((c) => [c.workflowId, c])),
    };
  });

  return (
    <>
      <PageHeader
        title="Automations"
        description="Workflows that run by themselves: when something happens (a job changes stage, a tag is added, a new lead comes in), do a series of steps. Emails and texts wait for approval unless a workflow is set to send them."
        actions={isOwner ? <Link href="/automations/new" className={buttonVariants()}>New workflow</Link> : undefined}
      />
      {workflows.length === 0 ? (
        <EmptyState>
          No workflows yet.{isOwner ? " Create one to send a confirmation when an inspection is scheduled, tag hot leads, or remind yourself to follow up." : " The owner can create them."}
        </EmptyState>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {workflows.map((w) => {
              const def = workflowDefinition(w);
              const c = counts.get(w.id);
              return (
                <li key={w.id}>
                  <Link href={`/automations/${w.id}`} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 hover:bg-muted/50">
                    <span className="min-w-0 flex-1 basis-64">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {w.name}
                        {w.autoSend && <Badge variant="destructive">Sends automatically</Badge>}
                      </span>
                      <span className="block text-sm text-muted-foreground">{def ? `When ${describeTrigger(def.trigger, options).replace(/^./, (x) => x.toLowerCase())}: ${describeSteps(def.steps)}` : "Needs fixing: open it and save again."}</span>
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {c ? <span>{c.done} done · {c.running} in progress{c.failed ? <span className="text-destructive"> · {c.failed} failed</span> : ""} (30 days)</span> : <span>No runs yet</span>}
                      <Status tone={w.active ? "ok" : "off"}>{w.active ? "On" : "Off"}</Status>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
