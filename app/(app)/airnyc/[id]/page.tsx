import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { CheckCircle2, Circle, ExternalLink, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { TaskList } from "@/components/task-list";
import { Timeline } from "@/components/timeline";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { expandFileName, getCase } from "@/lib/airnyc/cases";
import { loadJobOptions } from "@/lib/jobs/options";
import { stagesFor } from "@/lib/pipeline/config";
import { daysInStage } from "@/lib/pipeline/rules";
import { fmtDate, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { createCaseDriveFolder, createJobForCase, moveCaseStage, toggleChecklistItem, updateCase } from "../actions";
import { CaseFields } from "../case-fields";

export default async function CasePage({ params }: PageProps<"/airnyc/[id]">) {
  const { id } = await params;
  const user = await requireStaff();
  const data = await user.db(async (tx) => {
    const c = await getCase(tx, user.id, id);
    if (!c) return null;
    const [stages, items, done, tasks, activities, options, property] = await Promise.all([
      stagesFor(tx, "AIRNYC"),
      tx.select().from(s.airnycChecklistItems).where(eq(s.airnycChecklistItems.active, true)).orderBy(asc(s.airnycChecklistItems.position)),
      tx.select().from(s.airnycCaseChecklist).where(eq(s.airnycCaseChecklist.caseId, id)),
      tx.select().from(s.tasks).where(and(eq(s.tasks.airnycCaseId, id), isNull(s.tasks.archivedAt))).orderBy(asc(s.tasks.status), asc(s.tasks.dueAt)),
      tx.select().from(s.activities).where(eq(s.activities.airnycCaseId, id)).orderBy(desc(s.activities.occurredAt)).limit(100),
      loadJobOptions(tx),
      c.propertyId ? tx.select().from(s.properties).where(eq(s.properties.id, c.propertyId)).then((r) => r[0]) : Promise.resolve(undefined),
    ]);
    return { c, stages, items, done, tasks, activities, options, property };
  });
  if (!data) notFound();
  const { c, stages, items, done, tasks, activities, options, property } = data;
  const doneIds = new Set(done.map((d) => d.itemId));
  const current = stages.find((st) => st.key === c.stage);
  const stageName = (k: string) => stages.find((st) => st.key === k)?.name ?? titleCase(k);
  const itemsByStage = stages.map((st) => ({ stage: st, items: items.filter((i) => i.stage === st.key) })).filter((g) => g.items.length);

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{c.caseId}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge>{current?.name ?? c.stage}</Badge>
            <span>{daysInStage(c.stageEnteredAt)}d in stage</span>
            {c.network && <span>· {c.network}</span>}
            {c.isNycha && <Badge variant="destructive">NYCHA — consent risk</Badge>}
            {c.scopeNotCovered && <Badge variant="outline">Approved services don&apos;t cover scope</Badge>}
          </span>
        }
        actions={
          <>
            {c.sharepointFolderUrl && (
              <a href={c.sharepointFolderUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
                SharePoint <ExternalLink />
              </a>
            )}
            {c.driveFolderUrl ? (
              <a href={c.driveFolderUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
                <FolderOpen /> Drive
              </a>
            ) : (
              <ActionForm action={createCaseDriveFolder.bind(null, id)} className="flex flex-col items-end">
                <SubmitButton variant="outline">Create Drive folder</SubmitButton>
              </ActionForm>
            )}
            {c.jobId ? (
              <Link href={`/jobs/${c.jobId}`} className={buttonVariants()}>Open job</Link>
            ) : (
              <ActionForm action={createJobForCase.bind(null, id)} className="flex flex-col items-end">
                <SubmitButton>Create assessment job</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Member</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="font-medium">{c.memberName ?? "—"}</div>
            {c.guardianName && <div>Guardian: {c.guardianName}</div>}
            {c.memberPhone && <div><a className="hover:underline" href={`tel:${c.memberPhone}`}>{formatPhone(c.memberPhone)}</a></div>}
            {c.address && <div>{c.address}</div>}
            {property && <Link className="text-xs text-primary hover:underline" href={`/properties/${property.id}`}>Building record →</Link>}
            <div className="pt-2 text-xs text-muted-foreground">
              Case manager: {c.caseManagerName ?? "—"} {c.caseManagerEmail && <a className="hover:underline" href={`mailto:${c.caseManagerEmail}`}>({c.caseManagerEmail})</a>}
            </div>
            <div className="text-xs text-muted-foreground">Approved: {c.approvedServices.join(", ") || "—"}</div>
            <div className="text-xs text-muted-foreground">Consent — tenant: {titleCase(c.tenantConsentStatus)}, landlord: {titleCase(c.landlordConsentStatus)}</div>
            <div className="text-xs text-muted-foreground">QC: {titleCase(c.qcStatus)}{c.qcReviewer ? ` (${c.qcReviewer})` : ""}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Stage</CardTitle></CardHeader>
          <CardContent>
            <ActionForm key={c.stage} action={moveCaseStage.bind(null, id)} className="flex flex-wrap items-end gap-2">
              <Field label="Move to" className="flex-1">
                <NativeSelect name="stage" defaultValue={stages.find((st) => st.position > (current?.position ?? 0))?.key ?? c.stage}>
                  {stages.map((st) => <option key={st.key} value={st.key}>{st.name}{st.key === c.stage ? " (current)" : ""}</option>)}
                </NativeSelect>
              </Field>
              <SubmitButton>Move</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Tasks</CardTitle></CardHeader>
          <CardContent><TaskList tasks={tasks} link={{ airnycCaseId: id }} revalidate={`/airnyc/${id}`} /></CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>AIRnyc upload checklist</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {itemsByStage.map(({ stage, items }) => (
            <div key={stage.key}>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{stageName(stage.key)}</div>
              <ul className="space-y-1">
                {items.map((i) => {
                  const isDone = doneIds.has(i.id);
                  const doneRow = done.find((d) => d.itemId === i.id);
                  return (
                    <li key={i.id}>
                      <form action={toggleChecklistItem.bind(null, id, i.id, !isDone)} className="flex items-start gap-2 text-sm">
                        <button type="submit" aria-label={isDone ? "Mark not uploaded" : "Mark uploaded"} className="mt-0.5 text-primary">
                          {isDone ? <CheckCircle2 className="size-4" /> : <Circle className="size-4" />}
                        </button>
                        <span>
                          {i.label}
                          {i.fileNamePattern && (
                            <code className="ml-1 rounded bg-muted px-1 text-xs select-all">{expandFileName(i.fileNamePattern, c)}</code>
                          )}
                          {doneRow && <span className="block text-xs text-muted-foreground">Uploaded {fmtDate(doneRow.doneAt, true)}</span>}
                        </span>
                      </form>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
          <CardContent><Timeline items={activities} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Edit case</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={updateCase.bind(null, id)} className="space-y-4">
              <CaseFields c={c} properties={options.properties} />
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
