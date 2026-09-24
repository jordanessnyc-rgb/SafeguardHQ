import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { TaskList } from "@/components/task-list";
import { Timeline } from "@/components/timeline";
import { ComposeMessage } from "@/components/compose-message";
import { loadComposeData } from "@/lib/comms/compose-data";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { loadJobOptions } from "@/lib/jobs/options";
import { BRAND_LABELS, fmtDate, label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { stagesFor } from "@/lib/pipeline/config";
import { checkStageTransition, daysInStage, isStale } from "@/lib/pipeline/rules";
import {
  addDocument,
  addJobNote,
  addSample,
  archiveJob,
  createJobDriveFolder,
  moveJobStage,
  saveFinancials,
  setDocumentStatus,
  setSampleStatus,
  updateJob,
} from "../actions";
import { JobFields } from "../job-fields";

const SAMPLE_TYPES = s.sampleTypeEnum.enumValues;
const SAMPLE_STATUSES = s.sampleStatusEnum.enumValues;
const DOC_KINDS = s.documentKindEnum.enumValues;
const DOC_STATUSES = s.documentStatusEnum.enumValues;

export default async function JobPage({ params }: PageProps<"/jobs/[id]">) {
  const { id } = await params;
  const user = await requireStaff();
  const isOwner = user.role === "OWNER";

  const data = await user.db(async (tx) => {
    const [row] = await tx
      .select({ job: s.jobs, property: s.properties, org: s.organizations, contact: s.contacts })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId))
      .where(eq(s.jobs.id, id));
    if (!row) return null;
    const [stages, samples, documents, tasks, activities, options, financials] = await Promise.all([
      stagesFor(tx, row.job.pipelineKey),
      tx.select().from(s.samples).where(and(eq(s.samples.jobId, id), isNull(s.samples.archivedAt))).orderBy(asc(s.samples.sampleId)),
      tx.select().from(s.documents).where(and(eq(s.documents.jobId, id), isNull(s.documents.archivedAt))).orderBy(desc(s.documents.createdAt)),
      tx.select().from(s.tasks).where(and(eq(s.tasks.jobId, id), isNull(s.tasks.archivedAt))).orderBy(asc(s.tasks.status), asc(s.tasks.dueAt)),
      tx.select().from(s.activities).where(eq(s.activities.jobId, id)).orderBy(desc(s.activities.occurredAt)).limit(100),
      loadJobOptions(tx),
      // RLS returns nothing here for a VA; we also don't render the panel for them.
      isOwner ? tx.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, id)) : Promise.resolve([]),
    ]);
    return { ...row, stages, samples, documents, tasks, activities, options, financials: financials[0], compose: await loadComposeData(tx) };
  });
  if (!data) notFound();
  const { job, property, org, contact, stages, samples, documents, tasks, activities, options, financials, compose } = data;

  const current = stages.find((st) => st.key === job.stage);
  const stale = !current?.isTerminal && isStale(job.stageEnteredAt, current?.staleAfterDays ?? null);
  const submitted = samples.filter((x) => x.status === "SUBMITTED").length;
  const finalReports = documents.filter((d) => d.kind === "REPORT" && (d.status === "FINAL" || d.status === "SENT")).length;
  const blockers = new Map(
    stages.map((st) => [
      st.key,
      checkStageTransition({
        fromStage: job.stage,
        fromStageIsTerminal: current?.isTerminal ?? false,
        toStage: st.key,
        lostReason: "n/a", // the reason is typed in the form; only check the other rules here
        submittedSampleCount: submitted,
        finalReportCount: finalReports,
      }),
    ]),
  );
  const nextStage = stages.find((st) => st.position > (current?.position ?? 0) && !st.isTerminal);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{job.jobNumber}</span>
            <span className="font-normal text-muted-foreground">·</span>
            {label(SERVICE_LABELS, job.serviceCode)}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={stale ? "destructive" : "default"}>{current?.name ?? job.stage}</Badge>
            <span>
              {daysInStage(job.stageEnteredAt)}d in stage{stale ? ` (stale after ${current?.staleAfterDays}d)` : ""}
            </span>
            <span>· {label(BRAND_LABELS, job.brand)}</span>
            {job.title && <span>· {job.title}</span>}
          </span>
        }
        actions={
          job.driveFolderUrl ? (
            <a href={job.driveFolderUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
              <FolderOpen /> Drive folder
            </a>
          ) : (
            <ActionForm action={createJobDriveFolder.bind(null, id)} className="flex flex-col items-end gap-1">
              <SubmitButton variant="outline">Create Drive folder</SubmitButton>
            </ActionForm>
          )
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Move stage</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm key={job.stage} action={moveJobStage.bind(null, id)} className="flex flex-wrap items-end gap-2">
            <Field label="Stage" className="w-56">
              <NativeSelect name="stage" defaultValue={nextStage?.key ?? job.stage}>
                {stages.map((st) => {
                  const b = blockers.get(st.key) ?? [];
                  return (
                    <option key={st.key} value={st.key}>
                      {st.name}
                      {st.key === job.stage ? " (current)" : b.length ? " — blocked" : ""}
                    </option>
                  );
                })}
              </NativeSelect>
            </Field>
            <Field label="Lost reason (required for Lost)" className="min-w-56 flex-1">
              <Input name="lostReason" placeholder="e.g. chose another firm, price, no response" />
            </Field>
            <SubmitButton>Move</SubmitButton>
          </ActionForm>
          <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
            <li>
              Lab Pending needs ≥1 sample in SUBMITTED — {submitted ? `✓ ${submitted} submitted` : "none submitted yet"}.
            </li>
            <li>Delivered needs a FINAL report document — {finalReports ? "✓ on file" : "not on file yet"}.</li>
            <li>Lost needs a reason and can only be entered from an open stage.</li>
          </ul>
          {job.stage === "LOST" && job.lostReason && <p className="mt-2 text-sm">Lost reason: {job.lostReason}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Where &amp; who</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Property</div>
              {property ? (
                <Link className="hover:underline" href={`/properties/${property.id}`}>
                  {property.addressLine}
                  {property.unit ? ` #${property.unit}` : ""}, {property.borough}
                </Link>
              ) : (
                "—"
              )}
              {property?.isNycha && <Badge variant="destructive" className="ml-2">NYCHA</Badge>}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Client</div>
              {org && <Link className="hover:underline" href={`/organizations/${org.id}`}>{org.name}</Link>}
              {org && contact && " · "}
              {contact && <Link className="hover:underline" href={`/contacts/${contact.id}`}>{personName(contact)}</Link>}
              {!org && !contact && "—"}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Scheduled</div>
              {fmtDate(job.scheduledAt, true)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-xs text-muted-foreground">Field complete</div>
                {fmtDate(job.fieldCompletedAt)}
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Delivered</div>
                {fmtDate(job.deliveredAt)}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Samples</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {samples.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="hidden sm:table-cell">Location</TableHead>
                    <TableHead className="hidden sm:table-cell">COC #</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {samples.map((x) => (
                    <TableRow key={x.id}>
                      <TableCell className="font-mono text-xs">{x.sampleId}</TableCell>
                      <TableCell>{titleCase(x.type)}</TableCell>
                      <TableCell className="hidden sm:table-cell">{x.location ?? "—"}</TableCell>
                      <TableCell className="hidden sm:table-cell">{x.cocNumber ?? "—"}</TableCell>
                      <TableCell>
                        <form action={setSampleStatus.bind(null, id, x.id)} className="flex gap-1">
                          <NativeSelect name="status" defaultValue={x.status} className="h-7 w-32 text-xs" aria-label="Sample status">
                            {SAMPLE_STATUSES.map((st) => <option key={st} value={st}>{titleCase(st)}</option>)}
                          </NativeSelect>
                          <Button size="xs" variant="ghost" type="submit">Set</Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <ActionForm action={addSample.bind(null, id)} className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              <Input name="sampleId" placeholder="Sample ID" required className="col-span-1" />
              <NativeSelect name="type" defaultValue="AIR" aria-label="Type">
                {SAMPLE_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
              </NativeSelect>
              <Input name="location" placeholder="Location" className="col-span-2 sm:col-span-1" />
              <Input name="cocNumber" placeholder="COC #" />
              <NativeSelect name="status" defaultValue="COLLECTED" aria-label="Status">
                {SAMPLE_STATUSES.map((st) => <option key={st} value={st}>{titleCase(st)}</option>)}
              </NativeSelect>
              <SubmitButton size="sm" variant="secondary">Add sample</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {documents.length === 0 && <p className="text-sm text-muted-foreground">No documents yet.</p>}
            {documents.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <Badge variant="secondary">{titleCase(d.kind)}</Badge>{" "}
                  {d.storagePath ? (
                    <a className="hover:underline" href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">
                      {d.title ?? "Untitled"}
                    </a>
                  ) : (
                    d.title ?? "Untitled"
                  )}{" "}
                  <span className="text-xs text-muted-foreground">v{d.version}</span>
                  {d.containsPricing && <Badge variant="outline" className="ml-1">$ owner only</Badge>}
                </div>
                <form action={setDocumentStatus.bind(null, id, d.id)} className="flex gap-1">
                  <NativeSelect name="status" defaultValue={d.status} className="h-7 w-24 text-xs" aria-label="Document status">
                    {DOC_STATUSES.map((st) => <option key={st} value={st}>{titleCase(st)}</option>)}
                  </NativeSelect>
                  <Button size="xs" variant="ghost" type="submit">Set</Button>
                </form>
              </div>
            ))}
            <ActionForm action={addDocument.bind(null, id)} className="grid gap-2 border-t pt-3 sm:grid-cols-2">
              <NativeSelect name="kind" defaultValue="REPORT" aria-label="Kind">
                {DOC_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
              </NativeSelect>
              <NativeSelect name="status" defaultValue="DRAFT" aria-label="Status">
                {DOC_STATUSES.map((st) => <option key={st} value={st}>{titleCase(st)}</option>)}
              </NativeSelect>
              <Input name="title" placeholder="Title (defaults to file name)" className="sm:col-span-2" />
              <Input name="file" type="file" className="sm:col-span-2" />
              {isOwner && (
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" name="containsPricing" className="size-4 accent-primary" /> Contains pricing (hidden from VAs and subs)
                </label>
              )}
              <SubmitButton size="sm" variant="secondary">Add document</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
          </CardHeader>
          <CardContent>
            <TaskList tasks={tasks} link={{ jobId: id }} revalidate={`/jobs/${id}`} />
          </CardContent>
        </Card>
      </div>

      {isOwner && (
        <Card className="mt-4 border-primary/40">
          <CardHeader>
            <CardTitle>Financials (owner only)</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveFinancials.bind(null, id)} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Quoted $"><Input name="quotedAmount" inputMode="decimal" defaultValue={financials?.quotedAmount ?? ""} /></Field>
                <Field label="Sub cost $"><Input name="subCost" inputMode="decimal" defaultValue={financials?.subCost ?? ""} /></Field>
                <Field label="Lab cost $"><Input name="labCost" inputMode="decimal" defaultValue={financials?.labCost ?? ""} /></Field>
                <Field label="Other cost $"><Input name="otherCost" inputMode="decimal" defaultValue={financials?.otherCost ?? ""} /></Field>
              </div>
              <Field label="Line items" hint="One per line: Description | qty | unit price. These become the FreshBooks invoice lines in Phase 3.">
                <Textarea
                  name="lineItems"
                  rows={3}
                  defaultValue={financials?.lineItems.map((l) => `${l.description} | ${l.quantity} | ${l.unitPrice}`).join("\n")}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="holdReportUntilPaid" defaultChecked={financials?.holdReportUntilPaid ?? false} className="size-4 accent-primary" />
                Hold report until paid
              </label>
              <div className="flex items-center justify-between">
                <SubmitButton size="sm">Save financials</SubmitButton>
                {financials && <span className="text-sm">Gross margin: <strong>${financials.grossMargin}</strong></span>}
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {contact && !contact.doNotContact && (
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">Message {personName(contact)}</summary>
                <div className="mt-3">
                  <ComposeMessage
                    phones={contact.phones}
                    emails={contact.emails}
                    {...compose}
                    context={{ contactId: contact.id, jobId: id, airnycCaseId: job.airnycCaseId ?? undefined }}
                    revalidate={`/jobs/${id}`}
                    isOwner={isOwner}
                  />
                </div>
              </details>
            )}
            <ActionForm action={addJobNote.bind(null, id)} className="space-y-2">
              <Textarea name="body" rows={2} placeholder="Add a note…" />
              <SubmitButton size="sm" variant="secondary">Add note</SubmitButton>
            </ActionForm>
            <Timeline items={activities} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Edit job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionForm action={updateJob.bind(null, id)} className="space-y-4">
              <JobFields job={job} options={options} editing />
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
            <form action={archiveJob.bind(null, id)}>
              <Button type="submit" variant="destructive" size="sm">Archive job</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
