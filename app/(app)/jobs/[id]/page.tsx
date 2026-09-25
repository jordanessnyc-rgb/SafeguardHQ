import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { FolderOpen, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { TaskList } from "@/components/task-list";
import { Timeline } from "@/components/timeline";
import { ComposeMessage } from "@/components/compose-message";
import { loadComposeData } from "@/lib/comms/compose-data";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { loadJobOptions } from "@/lib/jobs/options";
import { BRAND_LABELS, fmtDate, label, personName, SERVICE_LABELS, titleCase, usd } from "@/lib/labels";
import { reportHeld } from "@/lib/money/invoicing";
import { docusignConfigFromEnv } from "@/lib/integrations/docusign";
import { stagesFor } from "@/lib/pipeline/config";
import { checkStageTransition, daysInStage, isStale } from "@/lib/pipeline/rules";
import { cn } from "@/lib/utils";
import {
  addDocument,
  addFieldPhoto,
  addJobNote,
  addSample,
  addSubQuote,
  buildQuote,
  createJobDriveFolder,
  createJobInvoice,
  draftReportAction,
  generateProposalDoc,
  makeSubCopy,
  refreshJobInvoice,
  refreshSignature,
  removeFieldPhoto,
  saveFieldData,
  saveFinancials,
  selectSubQuote,
  sendForSignature,
  setDocumentStatus,
  setSampleStatus,
  updateJob,
} from "../actions";
import { JobFields } from "../job-fields";
import { JobActions } from "./job-actions";

const SAMPLE_TYPES = s.sampleTypeEnum.enumValues;
const SAMPLE_STATUSES = s.sampleStatusEnum.enumValues;
const DOC_KINDS = s.documentKindEnum.enumValues;
const DOC_STATUSES = s.documentStatusEnum.enumValues;

const TABS = ["overview", "field", "documents", "messages", "money", "edit"] as const;
type Tab = (typeof TABS)[number];

export default async function JobPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
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
    const fin = financials[0];
    const [field] = await tx.select().from(s.fieldData).where(eq(s.fieldData.jobId, id));
    const money = isOwner
      ? {
          invoice: fin?.freshbooksInvoiceId ? (await tx.select().from(s.invoicesCache).where(eq(s.invoicesCache.freshbooksInvoiceId, fin.freshbooksInvoiceId)))[0] : undefined,
          held: await reportHeld(tx, row.job, fin),
          connected: (await tx.select({ id: s.freshbooksConnection.id }).from(s.freshbooksConnection)).length > 0,
          rule: (await tx.select().from(s.pricingRules).where(and(eq(s.pricingRules.serviceCode, row.job.serviceCode), eq(s.pricingRules.active, true))))[0],
          subQuotes: await tx
            .select({ q: s.subCosts, name: s.organizations.name })
            .from(s.subCosts)
            .leftJoin(s.organizations, eq(s.organizations.id, s.subCosts.subOrgId))
            .where(eq(s.subCosts.jobId, id))
            .orderBy(asc(s.subCosts.amount)),
          subOrgs: await tx
            .select({ id: s.organizations.id, name: s.organizations.name })
            .from(s.organizations)
            .where(and(eq(s.organizations.type, "SUBCONTRACTOR"), isNull(s.organizations.archivedAt)))
            .orderBy(asc(s.organizations.name)),
        }
      : null;
    return { ...row, stages, samples, documents, tasks, activities, options, financials: fin, money, field, compose: await loadComposeData(tx) };
  });
  if (!data) notFound();
  const { job, property, org, contact, stages, samples, documents, tasks, activities, options, financials, money, field, compose } = data;
  const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY);
  const docusignReady = Boolean(docusignConfigFromEnv());

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

  const tabParam = TABS.find((t) => t === sp.tab);
  const tab: Tab = tabParam === "money" && !isOwner ? "overview" : (tabParam ?? "overview");
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "field", label: "Field & samples", count: samples.length },
    { key: "documents", label: "Documents", count: documents.length },
    { key: "messages", label: "Messages & notes", count: activities.length },
    ...(isOwner ? [{ key: "money" as const, label: "Money" }] : []),
    { key: "edit", label: "Edit details" },
  ];

  // Stepper: the pipeline's open stages in order. A terminal current stage (Closed, Lost…) is shown as a badge instead.
  const openStages = stages.filter((st) => !st.isTerminal);
  const currentIdx = openStages.findIndex((st) => st.key === job.stage);
  const doneThrough = current?.isTerminal && job.stage !== "LOST" ? openStages.length : currentIdx;
  const nextStage = current?.isTerminal ? undefined : stages.find((st) => st.position > (current?.position ?? 0) && !st.isTerminal);
  const stageOptions = stages.filter((st) => st.key !== job.stage).map((st) => ({ key: st.key, name: st.name, blocked: blockers.get(st.key) ?? [] }));
  const later = openStages.slice(Math.max(currentIdx, 0) + 1);
  const needs = [
    later.some((st) => st.key === "LAB_PENDING") && { label: "Lab Pending", ok: submitted > 0, text: submitted ? `${submitted} sample${submitted === 1 ? "" : "s"} submitted` : "needs a sample marked Submitted" },
    later.some((st) => st.key === "DELIVERED") && { label: "Delivered", ok: finalReports > 0, text: finalReports ? "final report on file" : "needs a FINAL report document" },
  ].filter(Boolean) as { label: string; ok: boolean; text: string }[];

  const fact = (k: string, v: React.ReactNode, sub?: React.ReactNode) => (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{k}</div>
      <div className="truncate text-sm">{v}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 flex gap-1.5 text-xs text-muted-foreground">
        <Link href="/jobs" className="hover:underline">Jobs</Link>
        <span aria-hidden>/</span>
        <Link href={`/jobs?pipeline=${job.pipelineKey}`} className="hover:underline">{titleCase(job.pipelineKey)}</Link>
        <span aria-hidden>/</span>
        <span className="font-mono">{job.jobNumber}</span>
      </nav>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {label(SERVICE_LABELS, job.serviceCode)}
            <span className="font-mono text-base font-normal text-muted-foreground">{job.jobNumber}</span>
          </span>
        }
        description={
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant={stale ? "destructive" : "default"}>
              {current?.name ?? job.stage} · {daysInStage(job.stageEnteredAt)}d{stale ? ` (limit ${current?.staleAfterDays}d)` : ""}
            </Badge>
            {(job.priority === "URGENT" || job.priority === "HIGH") && <Badge variant="destructive">{titleCase(job.priority)} priority</Badge>}
            {property && (
              <Link className="hover:underline" href={`/properties/${property.id}`}>
                {property.addressLine}
                {property.unit ? ` #${property.unit}` : ""}
                {property.borough ? `, ${property.borough}` : ""}
              </Link>
            )}
            {org && <Link className="hover:underline" href={`/organizations/${org.id}`}>· {org.name}</Link>}
            <span>· {label(BRAND_LABELS, job.brand)}</span>
            {job.title && <span>· {job.title}</span>}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-start justify-end gap-2">
            {job.driveFolderUrl ? (
              <a href={job.driveFolderUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "lg" })}>
                <FolderOpen /> Drive
              </a>
            ) : (
              <ActionForm action={createJobDriveFolder.bind(null, id)} className="flex flex-col items-end gap-1">
                <SubmitButton variant="outline" size="lg">Create Drive folder</SubmitButton>
              </ActionForm>
            )}
            {contact && !contact.doNotContact && (
              <Link href={`/jobs/${id}?tab=messages`} className={buttonVariants({ variant: "outline", size: "lg" })}>
                <MessageSquare /> Message client
              </Link>
            )}
            <JobActions
              jobId={id}
              jobNumber={job.jobNumber}
              next={nextStage ? { key: nextStage.key, name: nextStage.name, blocked: blockers.get(nextStage.key) ?? [] } : null}
              stages={stageOptions}
              canMarkLost={!current?.isTerminal}
            />
          </div>
        }
      />

      <section aria-label="Pipeline progress" className="mb-4 rounded-xl border bg-card p-4">
        {current?.isTerminal && (
          <p className="mb-3 text-sm">
            <Badge variant={job.stage === "LOST" ? "destructive" : "secondary"}>{current.name}</Badge>
            {job.stage === "LOST" && job.lostReason && <span className="ml-2">Reason: {job.lostReason}</span>}
          </p>
        )}
        <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${openStages.length}, minmax(0, 1fr))` }}>
          {openStages.map((st, i) => (
            <li key={st.key} aria-current={i === currentIdx ? "step" : undefined} className="min-w-0">
              <div className={cn("h-1.5 rounded-full", i < doneThrough ? "bg-(--brand-sage)" : i === currentIdx ? "bg-primary" : "bg-muted")} />
              <div className={cn("mt-1.5 hidden truncate text-[11px] sm:block", i === currentIdx ? "font-semibold text-primary" : i < doneThrough ? "text-foreground" : "text-muted-foreground")} title={st.name}>
                {st.name}
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-1.5 text-xs text-muted-foreground sm:hidden">
          Step {Math.max(currentIdx, 0) + 1} of {openStages.length}
          {nextStage ? ` · next: ${nextStage.name}` : ""}
        </p>
        {(needs.length > 0 || (nextStage && (blockers.get(nextStage.key) ?? []).length > 0)) && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-xs">
            <span className="font-semibold">Coming up</span>
            {needs.map((n) => (
              <Status key={n.label} tone={n.ok ? "ok" : "warn"}>
                {n.label}: {n.text}
              </Status>
            ))}
          </div>
        )}
      </section>

      <nav aria-label="Job sections" className="mb-4 flex gap-1 overflow-x-auto border-b">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key === "overview" ? `/jobs/${id}` : `/jobs/${id}?tab=${t.key}`}
            scroll={false}
            aria-current={t.key === tab ? "page" : undefined}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              t.key === tab ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.count ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{t.count}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <Card>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                {fact(
                  "Property",
                  property ? (
                    <Link className="hover:underline" href={`/properties/${property.id}`}>
                      {property.addressLine}
                      {property.unit ? ` #${property.unit}` : ""}
                    </Link>
                  ) : (
                    "—"
                  ),
                  property ? (
                    <>
                      {property.borough}
                      {property.isNycha && <Badge variant="destructive" className="ml-1.5">NYCHA</Badge>}
                    </>
                  ) : null,
                )}
                {fact(
                  "Client",
                  org ? <Link className="hover:underline" href={`/organizations/${org.id}`}>{org.name}</Link> : contact ? <Link className="hover:underline" href={`/contacts/${contact.id}`}>{personName(contact)}</Link> : "—",
                  org && contact ? <Link className="hover:underline" href={`/contacts/${contact.id}`}>{personName(contact)}</Link> : null,
                )}
                {fact("Scheduled", fmtDate(job.scheduledAt, true))}
                {fact("Field complete", fmtDate(job.fieldCompletedAt))}
                {fact("Samples", samples.length ? `${samples.length} (${submitted} submitted)` : "None yet", <Link className="hover:underline" href={`/jobs/${id}?tab=field`}>Field &amp; samples →</Link>)}
                {fact("Delivered", fmtDate(job.deliveredAt), finalReports ? "Final report on file" : "No final report yet")}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Latest activity</CardTitle>
                <Link href={`/jobs/${id}?tab=messages`} className="text-sm font-medium text-primary hover:underline">All messages &amp; notes</Link>
              </CardHeader>
              <CardContent>
                <Timeline items={activities.slice(0, 5)} viewerIsOwner={isOwner} />
              </CardContent>
            </Card>
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Tasks</CardTitle>
              </CardHeader>
              <CardContent>
                <TaskList tasks={tasks} link={{ jobId: id }} revalidate={`/jobs/${id}`} />
              </CardContent>
            </Card>
            {isOwner && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Money</CardTitle>
                  <Badge variant="outline">Owner only</Badge>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Quoted</span><span className="tabular-nums">{financials?.quotedAmount ? usd(financials.quotedAmount) : "—"}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Gross margin</span><span className="font-semibold tabular-nums">{financials?.grossMargin ? usd(financials.grossMargin) : "—"}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Invoice</span><span>{financials?.freshbooksInvoiceId ? (financials.invoiceStatus ?? "draft") : "Not yet"}</span></div>
                  {money?.held && !financials?.reportReleasedAt && <p className="text-xs text-amber-700 dark:text-amber-400">Report held until paid.</p>}
                  <Link href={`/jobs/${id}?tab=money`} className="block pt-1 font-medium text-primary hover:underline">Quote, costs &amp; invoice →</Link>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === "field" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Field data</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <ActionForm action={saveFieldData.bind(null, id)} className="space-y-2">
                <Field label="Areas inspected" hint="Comma-separated, e.g. Bathroom, Bedroom 2, Hall closet">
                  <Input name="areas" defaultValue={field?.areas.join(", ") ?? ""} />
                </Field>
                <Field label="Observations">
                  <Textarea name="observations" rows={5} defaultValue={field?.observations ?? ""} placeholder="What you saw, area by area." />
                </Field>
                <Field label="Readings" hint="One per line: Area | moisture % | RH % | temp °F | note">
                  <Textarea name="readings" rows={3} defaultValue={(field?.readings ?? []).map((r) => [r.area, r.moisture, r.rh, r.temp, r.note].map((x) => x ?? "").join(" | ").replace(/( \| )+$/, "")).join("\n")} />
                </Field>
                <SubmitButton size="sm" variant="secondary">Save field data</SubmitButton>
              </ActionForm>
              <div className="space-y-3">
                <div className="text-sm font-medium">Photos ({field?.photos.length ?? 0})</div>
                {(field?.photos ?? []).length > 0 && (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {field!.photos.map((p, i) => (
                      <li key={p.path} className="text-xs">
                        <a href={`/api/field-photos/${id}/${i}`} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed storage URL via redirect */}
                          <img src={`/api/field-photos/${id}/${i}`} alt={p.caption} className="aspect-[4/3] w-full rounded border object-cover" loading="lazy" />
                        </a>
                        <div className="mt-0.5">{i + 1}. {p.area ? `${p.area} — ` : ""}{p.caption}</div>
                        <form action={removeFieldPhoto.bind(null, id, i)}>
                          <button className="text-muted-foreground underline" type="submit">remove</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
                <ActionForm action={addFieldPhoto.bind(null, id)} className="grid gap-2 sm:grid-cols-2">
                  <Input name="photo" type="file" accept="image/jpeg,image/png" capture="environment" className="sm:col-span-2" aria-label="Photo" />
                  <Input name="caption" placeholder="Caption (goes in the photo log)" aria-label="Caption" />
                  <Input name="area" placeholder="Area" aria-label="Area" list="field-areas" />
                  <datalist id="field-areas">{(field?.areas ?? []).map((a) => <option key={a} value={a} />)}</datalist>
                  <SubmitButton size="sm" variant="outline">Add photo</SubmitButton>
                </ActionForm>
                {aiEnabled && (
                  <ActionForm action={draftReportAction.bind(null, id)} className="flex flex-col items-start gap-1 border-t pt-3">
                    <SubmitButton size="sm">Draft report with AI</SubmitButton>
                    <span className="text-xs text-muted-foreground">Writes the findings, observations, results and recommendations from the field data, photos and samples into the report template as a DRAFT for Jordan to edit.</span>
                  </ActionForm>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
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
      )}

      {tab === "documents" && (
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
                  {isOwner && d.kind === "PROPOSAL" && d.docusignStatus && <Badge variant={d.docusignStatus === "completed" ? "default" : "secondary"} className="ml-1">e-sign: {d.docusignStatus}</Badge>}
                  {isOwner && docusignReady && d.kind === "PROPOSAL" && d.docusignEnvelopeId && ["sent", "delivered"].includes(d.docusignStatus ?? "") && (
                    <ActionForm action={refreshSignature.bind(null, id, d.docusignEnvelopeId)} className="mt-1 flex flex-col items-start gap-1">
                      <SubmitButton size="xs" variant="ghost">Check signature status</SubmitButton>
                    </ActionForm>
                  )}
                  {isOwner && docusignReady && d.kind === "PROPOSAL" && d.storagePath?.toLowerCase().endsWith(".docx") && (!d.docusignStatus || ["declined", "voided"].includes(d.docusignStatus)) && (
                    <ActionForm action={sendForSignature.bind(null, id, d.id)} className="mt-1 flex flex-wrap items-center gap-1">
                      <Input name="signerName" defaultValue={contact ? personName(contact) : ""} placeholder="Signer name" className="h-7 w-36 text-xs" aria-label="Signer name" />
                      <Input name="signerEmail" type="email" defaultValue={contact?.emails[0] ?? org?.email ?? ""} placeholder="Signer email" className="h-7 w-48 text-xs" aria-label="Signer email" />
                      <SubmitButton size="xs" variant="outline">Send for signature</SubmitButton>
                    </ActionForm>
                  )}
                  {isOwner && d.kind === "REPORT" && d.storagePath?.toLowerCase().endsWith(".docx") && (
                    <ActionForm action={makeSubCopy.bind(null, id, d.id)} className="mt-1 flex flex-col items-start gap-1">
                      <SubmitButton size="xs" variant="outline">Make sub copy</SubmitButton>
                    </ActionForm>
                  )}
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
      )}

      {tab === "messages" && (
        <Card>
          <CardContent className="space-y-4">
            {contact && !contact.doNotContact && (
              <details open className="rounded-lg border p-3">
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
            <Timeline items={activities} viewerIsOwner={isOwner} />
          </CardContent>
        </Card>
      )}

      {tab === "money" && isOwner && (
        <Card className="border-primary/40">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Money</CardTitle>
            <Badge variant="outline">Owner only</Badge>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveFinancials.bind(null, id)} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Quoted $"><Input name="quotedAmount" inputMode="decimal" defaultValue={financials?.quotedAmount ?? ""} /></Field>
                <Field label="Sub cost $"><Input name="subCost" inputMode="decimal" defaultValue={financials?.subCost ?? ""} /></Field>
                <Field label="Lab cost $"><Input name="labCost" inputMode="decimal" defaultValue={financials?.labCost ?? ""} /></Field>
                <Field label="Other cost $"><Input name="otherCost" inputMode="decimal" defaultValue={financials?.otherCost ?? ""} /></Field>
              </div>
              <Field label="Line items" hint="One per line: Description | qty | unit price. These become the FreshBooks invoice lines (else one line for the quoted amount).">
                <Textarea
                  name="lineItems"
                  rows={3}
                  defaultValue={financials?.lineItems.map((l) => `${l.description} | ${l.quantity} | ${l.unitPrice}`).join("\n")}
                />
              </Field>
              <Field label="Hold report until paid" className="max-w-xs">
                <NativeSelect name="holdReportUntilPaid" defaultValue={financials?.holdReportUntilPaid == null ? "" : String(financials.holdReportUntilPaid)}>
                  <option value="">Client / Settings default ({money?.held && financials?.holdReportUntilPaid == null ? "hold" : "don't hold"})</option>
                  <option value="true">Hold until paid</option>
                  <option value="false">Don&apos;t hold</option>
                </NativeSelect>
              </Field>
              <div className="flex items-center justify-between">
                <SubmitButton size="sm">Save financials</SubmitButton>
                {financials && <span className="text-sm">Gross margin: <strong>${financials.grossMargin}</strong></span>}
              </div>
            </ActionForm>

            <div className="mt-4 space-y-3 border-t pt-3 text-sm">
              <div className="font-medium">Quote builder</div>
              <p className="text-xs text-muted-foreground">
                {money?.rule
                  ? `Rule for this service: base ${usd(money.rule.baseAmount)}${money.rule.perSqft ? ` · ${usd(money.rule.perSqft)}/sq ft over ${money.rule.includedSqft.toLocaleString("en-US")}` : ""}${money.rule.perSample ? ` · ${usd(money.rule.perSample)}/sample over ${money.rule.includedSamples}` : ""}${money.rule.minimumAmount ? ` · minimum ${usd(money.rule.minimumAmount)}` : ""}.`
                  : "No pricing rule for this service yet (Settings → Pricing) — only extra lines are priced."}{" "}
                Building the quote replaces the line items above.
              </p>
              <ActionForm action={buildQuote.bind(null, id)} className="grid gap-2 sm:grid-cols-4">
                <Field label="Area (sq ft)"><Input name="sqft" inputMode="numeric" defaultValue={financials?.quoteInputs?.sqft ?? ""} /></Field>
                <Field label="Samples"><Input name="samples" inputMode="numeric" defaultValue={financials?.quoteInputs?.samples ?? samples.length ?? ""} /></Field>
                <Field label="Valid (days)"><Input name="validDays" inputMode="numeric" defaultValue={financials?.quoteInputs?.validDays ?? 30} /></Field>
                <div />
                <Field label="Extra lines" hint="Description | qty | unit price" className="sm:col-span-2">
                  <Textarea name="extras" rows={2} defaultValue={financials?.quoteInputs?.extras?.map((l) => `${l.description} | ${l.quantity} | ${l.unitPrice}`).join("\n")} />
                </Field>
                <Field label="Scope (shown on the proposal)" className="sm:col-span-2">
                  <Textarea name="scope" rows={2} defaultValue={financials?.quoteInputs?.scope ?? money?.rule?.defaultScope ?? ""} />
                </Field>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
                  <SubmitButton size="sm" variant="secondary">Build quote</SubmitButton>
                </div>
              </ActionForm>
              {(financials?.lineItems.length ?? 0) > 0 && (
                <ActionForm action={generateProposalDoc.bind(null, id)} className="flex flex-col items-start gap-1">
                  <SubmitButton size="sm">Generate proposal (Word)</SubmitButton>
                </ActionForm>
              )}

              <div className="font-medium">Subcontractor quotes</div>
              {money && money.subQuotes.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sub</TableHead>
                      <TableHead className="text-right">Their price</TableHead>
                      <TableHead className="text-right">ESS margin</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {money.subQuotes.map(({ q, name }) => {
                      const margin = financials?.quotedAmount ? Number(financials.quotedAmount) - Number(q.amount ?? 0) - Number(financials.labCost ?? 0) - Number(financials.otherCost ?? 0) : null;
                      return (
                        <TableRow key={q.id}>
                          <TableCell>
                            {name ?? "—"} {q.description && <span className="text-xs text-muted-foreground">· {q.description}</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{usd(q.amount)}</TableCell>
                          <TableCell className="text-right tabular-nums">{margin === null ? "—" : usd(margin)}</TableCell>
                          <TableCell className="text-right">
                            {q.selected ? (
                              <Badge>chosen</Badge>
                            ) : (
                              <form action={selectSubQuote.bind(null, id, q.id)}>
                                <Button size="xs" variant="ghost" type="submit">Use this sub</Button>
                              </form>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-xs text-muted-foreground">No sub quotes yet.</p>
              )}
              {money && money.subOrgs.length > 0 ? (
                <ActionForm action={addSubQuote.bind(null, id)} className="flex flex-wrap items-end gap-2">
                  <NativeSelect name="subOrgId" className="h-8 w-48" aria-label="Subcontractor">
                    {money.subOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </NativeSelect>
                  <Input name="amount" inputMode="decimal" placeholder="Price $" className="h-8 w-28" aria-label="Sub price" />
                  <Input name="description" placeholder="Notes (scope, timing)" className="h-8 w-56" aria-label="Notes" />
                  <SubmitButton size="xs" variant="secondary">Add sub quote</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-xs text-muted-foreground">Add an organization of type Subcontractor to compare sub quotes.</p>
              )}
            </div>

            <div className="mt-4 space-y-2 border-t pt-3 text-sm">
              <div className="font-medium">FreshBooks invoice</div>
              {financials?.freshbooksInvoiceId ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>#{money?.invoice?.invoiceNumber ?? financials.freshbooksInvoiceId}</span>
                  <Badge variant={financials.paidAt ? "default" : "secondary"}>{financials.invoiceStatus ?? "draft"}</Badge>
                  {money?.invoice?.amount && (
                    <span className="text-muted-foreground">
                      {usd(money.invoice.amount)}
                      {Number(money.invoice.outstanding ?? 0) > 0 && ` · ${usd(money.invoice.outstanding)} outstanding`}
                      {money.invoice.dueAt && ` · due ${fmtDate(money.invoice.dueAt)}`}
                    </span>
                  )}
                  {financials.paidAt && <span className="text-muted-foreground">paid {fmtDate(financials.paidAt)}</span>}
                  <ActionForm action={refreshJobInvoice.bind(null, id)} className="inline-flex flex-col">
                    <SubmitButton size="xs" variant="ghost">Refresh</SubmitButton>
                  </ActionForm>
                  <a href="https://my.freshbooks.com/#/invoices" target="_blank" rel="noreferrer" className="text-xs underline">Open FreshBooks</a>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-muted-foreground">
                    {!money?.connected
                      ? "FreshBooks isn't connected yet (Settings → FreshBooks)."
                      : job.stage === "DELIVERED"
                        ? "Drafts are automatic for jobs delivered after FreshBooks was connected; use the button for older jobs."
                        : "A draft invoice is created when this job is marked Delivered."}
                  </p>
                  {financials?.invoiceError && <p className="text-destructive">Last attempt failed: {financials.invoiceError}</p>}
                  {money?.connected && (
                    <ActionForm action={createJobInvoice.bind(null, id)} className="flex flex-col items-start gap-1">
                      <SubmitButton size="xs" variant="outline">{financials?.invoiceError ? "Retry draft invoice" : "Create draft invoice now"}</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              )}
              {money?.held && (
                <p className={financials?.reportReleasedAt ? "text-primary" : "text-amber-700 dark:text-amber-400"}>
                  {financials?.reportReleasedAt ? `Paid — report released ${fmtDate(financials.reportReleasedAt)}.` : "Report is held until this invoice is paid — don't send it to the client yet."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "edit" && (
        <Card>
          <CardHeader>
            <CardTitle>Edit job details</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateJob.bind(null, id)} className="space-y-4">
              <JobFields job={job} options={options} editing />
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </>
  );
}
