import { desc, eq, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/page-header";
import { requireOwner } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate } from "@/lib/labels";
import { loadHealth, type HealthItem, type Level } from "@/lib/admin/health";
import { listDeadJobs, webBoss, type DeadJob } from "@/lib/admin/dead-letter";
import { auditChanges } from "@/lib/admin/audit";
import { dismissJob, retryJob } from "./actions";

export const metadata = { title: "System health" };

const LEVEL: Record<Level, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-primary/10 text-primary" },
  warn: { label: "Check", className: "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200" },
  error: { label: "Problem", className: "bg-destructive/10 text-destructive" },
  off: { label: "Not set up", className: "bg-muted text-muted-foreground" },
};

function HealthList({ items }: { items: HealthItem[] }) {
  return (
    <ul className="divide-y text-sm">
      {items.map((i) => (
        <li key={i.name} className="flex items-start gap-3 py-2">
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${LEVEL[i.level].className}`}>{LEVEL[i.level].label}</span>
          <span className="min-w-0">
            <span className="font-medium">{i.name}</span>
            <span className="block break-words text-xs text-muted-foreground">{i.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const user = await requireOwner();
  const sp = await searchParams;
  const entity = typeof sp.entity === "string" && /^[a-z_]+$/.test(sp.entity) ? sp.entity : "";

  const [health, audit] = await user.db(async (tx) => [
    await loadHealth(tx),
    await tx.select().from(s.auditLog).where(entity ? eq(s.auditLog.entity, entity) : undefined).orderBy(desc(s.auditLog.at)).limit(100),
  ] as const);
  const actorIds = [...new Set(audit.map((a) => a.actor).filter((a): a is string => Boolean(a)))];
  const actors = actorIds.length ? await user.db((tx) => tx.select({ id: s.profiles.userId, name: s.profiles.fullName, email: s.profiles.email }).from(s.profiles).where(inArray(s.profiles.userId, actorIds))) : [];
  const actorName = new Map(actors.map((a) => [a.id, a.name ?? a.email]));

  let dead: DeadJob[] = [];
  let deadError: string | null = null;
  try {
    dead = await listDeadJobs(await webBoss());
  } catch (e) {
    deadError = (e as Error).message;
  }

  const ENTITIES = ["job_financials", "invoices_cache", "payments_cache", "sub_costs", "campaign_costs", "pricing_rules", "airnyc_cases"];

  return (
    <>
      <PageHeader title="System health" description="Owner only. Integrations, background work, failed jobs and the audit trail." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Integrations</CardTitle>
          </CardHeader>
          <CardContent>
            <HealthList items={health.integrations} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Background tasks</CardTitle>
            <CardDescription>What the worker runs on a timer, and how the last run went.</CardDescription>
          </CardHeader>
          <CardContent>{health.tasks.length ? <HealthList items={health.tasks} /> : <p className="text-sm text-muted-foreground">The worker hasn&apos;t reported any tasks yet.</p>}</CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Failed jobs</CardTitle>
          <CardDescription>Jobs that failed after all their automatic retries. Retry once the cause is fixed, or dismiss.</CardDescription>
        </CardHeader>
        <CardContent>
          {deadError ? (
            <p className="text-sm text-destructive">Couldn&apos;t read the job queue: {deadError}</p>
          ) : dead.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y text-sm">
              {dead.map((j) => (
                <li key={j.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{j.queue ?? "unknown queue"}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      failed {fmtDate(j.failedAt, true)}
                      {j.retries != null && ` after ${j.retries} retries`}
                    </span>
                    {j.error && <span className="block break-words text-xs text-destructive">{j.error}</span>}
                    <code className="block break-all text-xs text-muted-foreground">{JSON.stringify(j.data)}</code>
                  </span>
                  <span className="flex gap-1">
                    <form action={retryJob.bind(null, j.id)}>
                      <Button size="xs" variant="outline" type="submit">Retry</Button>
                    </form>
                    <form action={dismissJob.bind(null, j.id)}>
                      <Button size="xs" variant="ghost" type="submit">Dismiss</Button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>Every change to money tables and every read of AIRnyc member data. Latest 100.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-wrap items-center gap-2 text-sm">
            <NativeSelect name="entity" defaultValue={entity} className="h-8 w-56" aria-label="Table">
              <option value="">All tables</option>
              {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
            </NativeSelect>
            <Button size="sm" variant="secondary" type="submit">Filter</Button>
          </form>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {audit.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <Badge variant={a.action === "BLOCKED" ? "destructive" : "outline"}>{a.action}</Badge>
                    <span className="font-medium">{a.entity}</span>
                    <span className="text-xs text-muted-foreground">
                      {fmtDate(a.at, true)} · {a.actor ? (actorName.get(a.actor) ?? "user") : "system"}
                    </span>
                  </div>
                  <div className="break-words text-xs text-muted-foreground">{auditChanges(a.action, a.detail)}</div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
