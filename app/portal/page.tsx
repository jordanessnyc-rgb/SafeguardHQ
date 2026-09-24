import { asc, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSub } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { fmtDate, label, SERVICE_LABELS, titleCase } from "@/lib/labels";

export const metadata = { title: "Your jobs" };

/** Jobs assigned to this subcontractor and the released scope documents (sub copies). Nothing else. */
export default async function PortalPage() {
  const user = await requireSub();
  const { jobs, docs } = await user.db(async (tx) => {
    const jobs = await tx.select().from(s.subPortalJobs).orderBy(asc(s.subPortalJobs.scheduledAt));
    const docs = jobs.length ? await tx.select().from(s.subPortalDocuments).where(inArray(s.subPortalDocuments.jobId, jobs.map((j) => j.id))) : [];
    return { jobs, docs };
  });

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Your jobs</h1>
      <p className="mb-5 text-sm text-muted-foreground">Scope documents appear here once ESS releases them. Questions: 929-305-1232 · sales@ess-nyc.com</p>
      {jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs are assigned to you right now.</p>}
      <div className="space-y-3">
        {jobs.map((j) => {
          const mine = docs.filter((d) => d.jobId === j.id);
          return (
            <Card key={j.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  <span className="font-mono text-sm">{j.jobNumber}</span> {label(SERVICE_LABELS, j.serviceCode)}
                  <Badge variant="secondary">{titleCase(j.stage)}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>{[j.addressLine, j.unit && `Apt ${j.unit}`, j.borough, j.zip].filter(Boolean).join(", ") || "Address to follow"}</div>
                <div className="text-muted-foreground">Scheduled: {j.scheduledAt ? fmtDate(j.scheduledAt, true) : "not yet"}</div>
                {mine.length ? (
                  <ul className="space-y-1">
                    {mine.map((d) => (
                      <li key={d.id}>
                        <a className="text-primary underline" href={`/portal/documents/${d.id}`} target="_blank" rel="noreferrer">{d.title ?? "Scope document"}</a>{" "}
                        <span className="text-xs text-muted-foreground">v{d.version} · {fmtDate(d.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-xs text-muted-foreground">No scope document released yet.</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
