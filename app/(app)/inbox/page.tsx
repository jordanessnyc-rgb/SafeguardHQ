import Link from "next/link";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm, SubmitButton } from "@/components/forms";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RevealSensitive } from "@/components/reveal-sensitive";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { TRIAGE_CATEGORIES, type Triage } from "@/lib/ai/classify";
import { fmtDate, label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { formatPhone } from "@/lib/phone";
import { inboxReviewWhere } from "@/lib/queues";
import { reviewActivity } from "../comms/actions";

export const metadata = { title: "Inbox review" };

/** SPEC §9.1 review queue: low-confidence triage, AI-blocked (AIRnyc) items, and stuck messages. */
export default async function InboxPage() {
  const user = await requireStaff();
  const { items, jobs } = await user.db(async (tx) => ({
    items: await tx
      .select({ a: s.activities, contact: { id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName }, jobNumber: s.jobs.jobNumber })
      .from(s.activities)
      .leftJoin(s.contacts, eq(s.contacts.id, s.activities.contactId))
      .leftJoin(s.jobs, eq(s.jobs.id, s.activities.jobId))
      .where(inboxReviewWhere)
      .orderBy(desc(s.activities.occurredAt))
      .limit(100),
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
        title="Inbox review"
        description="Messages the AI wasn't sure about, AIRnyc messages it isn't allowed to read, and anything not yet triaged. File each one."
      />
      {items.length === 0 ? (
        <EmptyState>All caught up.</EmptyState>
      ) : (
        <div className="space-y-3">
          {items.map(({ a, contact, jobNumber }) => {
            const ai = a.aiClassification as (Partial<Triage> & { error?: string; blocked?: string }) | null;
            return (
              <Card key={a.id}>
                <CardContent className="space-y-2">
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
                  {ai && !ai.blocked && (
                    <p className="text-xs">
                      {ai.error ? (
                        <span className="text-destructive">AI error: {ai.error}</span>
                      ) : (
                        <>
                          AI guess: <strong>{titleCase(ai.category ?? "OTHER")}</strong> ({Math.round((ai.confidence ?? 0) * 100)}%)
                          {ai.service_code && ` · ${label(SERVICE_LABELS, ai.service_code)}`}
                          {ai.urgency && ai.urgency !== "NORMAL" && ` · ${ai.urgency.toLowerCase()}`} — {ai.summary}
                        </>
                      )}
                    </p>
                  )}
                  <ActionForm action={reviewActivity.bind(null, a.id)} className="flex flex-wrap items-center gap-2">
                    <NativeSelect name="category" defaultValue={a.triageCategory ?? ai?.category ?? ""} className="w-44" aria-label="Category">
                      <option value="">— category —</option>
                      {TRIAGE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
                    </NativeSelect>
                    <NativeSelect name="jobId" defaultValue={a.jobId ?? ""} className="w-64" aria-label="Job">
                      <option value="">— file under job —</option>
                      {jobs.map((j) => <option key={j.id} value={j.id}>{j.jobNumber}{j.address ? ` · ${j.address}` : ""}</option>)}
                    </NativeSelect>
                    <SubmitButton size="sm">File</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
