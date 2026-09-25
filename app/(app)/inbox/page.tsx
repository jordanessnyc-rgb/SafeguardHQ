import Link from "next/link";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, SubmitButton } from "@/components/forms";
import { JobPicker } from "@/components/job-picker";
import { EmptyState, PageHeader } from "@/components/page-header";
import { QueueKeyboard, QueueTabs } from "@/components/review-queue";
import { RevealSensitive } from "@/components/reveal-sensitive";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { TRIAGE_CATEGORIES, type Triage } from "@/lib/ai/classify";
import { fmtDate, label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { inboxReviewWhere, OUTBOX_WAITING, suggestJob } from "@/lib/queues";
import { reviewActivity } from "../comms/actions";

export const metadata = { title: "Inbox review" };

/** SPEC §9.1 review queue: low-confidence triage, AI-blocked (AIRnyc) items, and stuck messages. */
export default async function InboxPage() {
  const user = await requireStaff();
  const { items, jobs, total, toApprove } = await user.db(async (tx) => ({
    items: await tx
      .select({ a: s.activities, contact: { id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName }, jobNumber: s.jobs.jobNumber })
      .from(s.activities)
      .leftJoin(s.contacts, eq(s.contacts.id, s.activities.contactId))
      .leftJoin(s.jobs, eq(s.jobs.id, s.activities.jobId))
      .where(inboxReviewWhere)
      .orderBy(desc(s.activities.occurredAt))
      .limit(100),
    total: (await tx.select({ n: count() }).from(s.activities).where(inboxReviewWhere))[0].n,
    toApprove: (await tx.select({ n: count() }).from(s.outboundMessages).where(inArray(s.outboundMessages.status, [...OUTBOX_WAITING])))[0].n,
    jobs: await tx
      .select({ id: s.jobs.id, jobNumber: s.jobs.jobNumber, address: s.properties.addressLine })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .where(and(isNull(s.jobs.archivedAt), sql`${s.jobs.stage} not in ('CLOSED','LOST','NEXT_CYCLE_SCHEDULED')`))
      .orderBy(desc(s.jobs.createdAt))
      .limit(500),
  }));

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Messages the AI wasn't sure about, AIRnyc messages it isn't allowed to read, and anything not yet triaged. File each one."
        actions={<QueueTabs active="inbox" toFile={total} toApprove={toApprove} />}
      />
      {items.length === 0 ? (
        <EmptyState>All caught up — nothing to file.</EmptyState>
      ) : (
        <div className="space-y-3">
          {total > items.length && <p className="text-sm text-muted-foreground">Showing the newest {items.length} of {total}.</p>}
          {items.map(({ a, contact, jobNumber }) => {
            const ai = a.aiClassification as (Partial<Triage> & { error?: string; blocked?: string }) | null;
            const guess = ai && !ai.blocked && !ai.error && ai.category ? ai : null;
            const job = a.jobId ? jobs.find((j) => j.id === a.jobId) : suggestJob(guess?.job_match_hints, jobs);
            const review = reviewActivity.bind(null, a.id);
            return (
              <Card key={a.id} data-queue-item tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus:ring-2 focus:ring-primary/40">
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{a.type === "SMS" ? "Text" : "Email"}</Badge>
                    <Badge variant={a.triageStatus === "BLOCKED" ? "outline" : "destructive"}>
                      {a.triageStatus === "BLOCKED" ? "AI blocked (AIRnyc)" : a.triageStatus === "PENDING" ? "Not triaged" : "Needs review"}
                    </Badge>
                    <span>{fmtDate(a.occurredAt, true)}</span>
                    <span>· from {a.fromAddress?.startsWith("+") ? formatPhone(a.fromAddress) : a.fromAddress}</span>
                    {contact?.id && <Link className="hover:underline" href={`/contacts/${contact.id}`}>({personName(contact)})</Link>}
                    {jobNumber && <span className="font-mono">{jobNumber}</span>}
                  </div>
                  {a.sensitive ? (
                    <RevealSensitive activityId={a.id} />
                  ) : (
                    <>
                      {a.subject && <div className="font-medium">{a.subject}</div>}
                      <div className="line-clamp-4 text-sm whitespace-pre-line text-muted-foreground">{a.body}</div>
                    </>
                  )}
                  {ai?.error && <p className="text-xs text-destructive">AI error: {ai.error}</p>}

                  {guess && (
                    <ActionForm action={review} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/25 bg-sidebar p-3">
                      <input type="hidden" name="category" value={guess.category} />
                      {job && <input type="hidden" name="jobId" value={job.id} />}
                      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0 flex-1 text-sm">
                        <div>
                          <span className="font-semibold text-primary">Suggested: {titleCase(guess.category!)}</span>
                          {job && <span> · file under <span className="font-mono text-xs">{job.jobNumber}</span>{job.address ? ` (${job.address})` : ""}</span>}
                          <span className="text-xs text-muted-foreground"> · {Math.round((guess.confidence ?? 0) * 100)}% sure</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {guess.service_code && `${label(SERVICE_LABELS, guess.service_code)} · `}
                          {guess.urgency && guess.urgency !== "NORMAL" && `${guess.urgency.toLowerCase()} · `}
                          {guess.summary}
                        </div>
                      </div>
                      <span data-accept>
                        <SubmitButton size="sm">Accept suggestion</SubmitButton>
                      </span>
                    </ActionForm>
                  )}

                  <ActionForm action={review} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{guess ? "Or file it yourself:" : "File it:"}</span>
                    <NativeSelect name="category" defaultValue={a.triageCategory ?? guess?.category ?? ""} className="w-44" aria-label="Category">
                      <option value="">— category —</option>
                      {TRIAGE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
                    </NativeSelect>
                    <JobPicker jobs={jobs} defaultJobId={a.jobId} className="w-full sm:w-72" />
                    <SubmitButton size="sm" variant={guess ? "outline" : "default"}>File</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
            );
          })}
          <QueueKeyboard
            hints={[
              { key: "J", label: "next" },
              { key: "K", label: "previous" },
              { key: "A", label: "accept suggestion" },
              { key: "/", label: "find a job" },
            ]}
          />
        </div>
      )}
    </>
  );
}
