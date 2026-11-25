import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate, personName } from "@/lib/labels";
import { workflowDefinition } from "@/lib/automation/engine";
import { describeTrigger, editorOptions } from "@/lib/automation/describe";
import { deleteWorkflow, saveWorkflow, setWorkflowActive } from "../actions";
import { WorkflowEditor } from "../workflow-editor";

const RUN_TONE = { RUNNING: "warn", WAITING: "warn", DONE: "ok", STOPPED: "off", SKIPPED: "off", FAILED: "error" } as const;
const RUN_LABEL = { RUNNING: "Running", WAITING: "Waiting", DONE: "Done", STOPPED: "Stopped", SKIPPED: "Skipped", FAILED: "Failed" } as const;

export default async function WorkflowPage({ params }: PageProps<"/automations/[id]">) {
  const { id } = await params;
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";
  const data = await user.db(async (tx) => {
    const [w] = await tx.select().from(s.workflows).where(eq(s.workflows.id, id));
    if (!w) return null;
    const runs = await tx
      .select({ run: s.workflowRuns, jobNumber: s.jobs.jobNumber, contact: { firstName: s.contacts.firstName, lastName: s.contacts.lastName }, orgName: s.organizations.name })
      .from(s.workflowRuns)
      .leftJoin(s.jobs, eq(s.jobs.id, s.workflowRuns.jobId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.workflowRuns.contactId))
      .leftJoin(s.organizations, eq(s.organizations.id, s.workflowRuns.orgId))
      .where(eq(s.workflowRuns.workflowId, id))
      .orderBy(desc(s.workflowRuns.createdAt))
      .limit(50);
    return { w, runs, options: await editorOptions(tx) };
  });
  if (!data) notFound();
  const { w, runs, options } = data;
  const def = workflowDefinition(w);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-xs text-muted-foreground">
        <Link href="/automations" className="hover:underline">Automations</Link> / {w.name}
      </nav>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{w.name} <Status tone={w.active ? "ok" : "off"}>{w.active ? "On" : "Off"}</Status>{w.autoSend && <Badge variant="destructive">Sends automatically</Badge>}</span>}
        description={def ? `When ${describeTrigger(def.trigger, options).replace(/^./, (x) => x.toLowerCase())}.${w.active && w.activatedAt ? ` On since ${fmtDate(w.activatedAt, true)}.` : ""}` : undefined}
        actions={
          isOwner ? (
            <>
              <form action={setWorkflowActive.bind(null, w.id, !w.active)}>
                <SubmitButton variant={w.active ? "outline" : "default"}>{w.active ? "Switch off" : "Switch on"}</SubmitButton>
              </form>
              <form action={deleteWorkflow.bind(null, w.id)}>
                <ConfirmSubmit title={`Delete “${w.name}”?`} description="Its history goes too. Messages it already drafted stay in the Outbox." confirmLabel="Delete workflow" variant="ghost" size="default" className="text-destructive">
                  Delete
                </ConfirmSubmit>
              </form>
            </>
          ) : undefined
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <WorkflowEditor
          action={saveWorkflow.bind(null, w.id)}
          canEdit={isOwner}
          options={options}
          initial={{ name: w.name, description: w.description ?? "", autoSend: w.autoSend, trigger: w.trigger, conditions: w.conditions, steps: w.steps }}
        />
        <Card className="h-fit gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>The last 50 records this workflow started for, and what it did.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {runs.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{w.active ? "Nothing has triggered it yet." : "It hasn't run. Switch it on to start."}</p>
            ) : (
              <ul className="divide-y">
                {runs.map(({ run, jobNumber, contact, orgName }) => {
                  const who = run.jobId ? { href: `/jobs/${run.jobId}`, label: jobNumber ?? "Job" } : run.contactId ? { href: `/contacts/${run.contactId}`, label: contact ? personName(contact) : "Person" } : { href: `/organizations/${run.orgId}`, label: orgName ?? "Company" };
                  return (
                    <li key={run.id} className="space-y-1 px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={who.href} className="font-medium hover:underline">{who.label}</Link>
                        <Status tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Status>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Started {fmtDate(run.createdAt, true)}
                        {run.status === "WAITING" && ` · next step ${fmtDate(run.resumeAt, true)}`}
                      </div>
                      {run.log.length > 0 && (
                        <ul className="space-y-0.5 text-xs">
                          {run.log.slice(-6).map((l, i) => (
                            <li key={i} className={l.outcome === "failed" ? "text-destructive" : l.outcome === "skipped" || l.outcome === "stopped" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"}>
                              {l.note}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
