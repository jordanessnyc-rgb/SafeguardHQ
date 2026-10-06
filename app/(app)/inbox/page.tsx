import Link from "next/link";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ArrowLeft, ChevronLeft, ChevronRight, ImageOff, MessageSquare, Paperclip, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { SubmitButton } from "@/components/forms";
import { JobPicker } from "@/components/job-picker";
import { EmptyState, PageHeader } from "@/components/page-header";
import { QueueTabs } from "@/components/review-queue";
import { RevealSensitive } from "@/components/reveal-sensitive";
import { EmailFrame } from "@/components/inbox/email-frame";
import { FileForm } from "@/components/inbox/file-form";
import { InboxKeys } from "@/components/inbox/inbox-keys";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { TRIAGE_CATEGORIES, type Triage } from "@/lib/ai/classify";
import { label, personName, SERVICE_LABELS, titleCase } from "@/lib/labels";
import { emailDocument, splitQuoted } from "@/lib/mail/render";
import type { EmailMeta, MailAddress } from "@/lib/mail/meta";
import { formatPhone } from "@/lib/phone";
import { inboxReviewWhere, OUTBOX_WAITING, suggestJob } from "@/lib/queues";
import { cn } from "@/lib/utils";
import { reviewActivity } from "../comms/actions";

export const metadata = { title: "Messages" };

const TZ = "America/New_York";
const AVATAR = ["bg-emerald-700", "bg-sky-700", "bg-amber-600", "bg-fuchsia-700", "bg-teal-700", "bg-rose-700", "bg-indigo-700", "bg-lime-700"];

const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
/** "2:04 PM" today, "Sep 29" this year, "9/29/25" before — like a mail list. */
function listTime(d: Date, now: Date) {
  if (nyDay(d) === nyDay(now)) return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  if (nyDay(d).slice(0, 4) === nyDay(now).slice(0, 4)) return d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { timeZone: TZ, month: "numeric", day: "numeric", year: "2-digit" });
}
function fullTime(d: Date, now: Date) {
  const abs = d.toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: nyDay(d).slice(0, 4) === nyDay(now).slice(0, 4) ? undefined : "numeric", hour: "numeric", minute: "2-digit" });
  const mins = Math.round((now.getTime() - d.getTime()) / 60_000);
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 24 * 60 ? `${Math.round(mins / 60)} hr ago` : mins < 7 * 24 * 60 ? `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? "" : "s"} ago` : null;
  return ago ? `${abs} (${ago})` : abs;
}
const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const who = (a: MailAddress) => a.name || a.address || "unknown";

function Avatar({ name, className }: { name: string; className?: string }) {
  const words = name.replace(/[^\p{L} ]/gu, "").split(/\s+/).filter(Boolean);
  // A phone number or bare address has no name to take initials from.
  const initials = words.length ? (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() : "#";
  const hue = [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length;
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white", AVATAR[hue], className)}>
      {initials}
    </span>
  );
}

/** Plain-text email (no HTML version): links clickable, the quoted thread folded away. */
function EmailText({ text }: { text: string }) {
  const { main, quoted } = splitQuoted(text);
  const linkify = (t: string) =>
    t.split(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g).map((part, i) =>
      i % 2 ? (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">
          {part}
        </a>
      ) : (
        part
      ),
    );
  return (
    <div className="text-sm leading-relaxed">
      <div className="whitespace-pre-line">{main ? linkify(main) : <span className="text-muted-foreground">(no text)</span>}</div>
      {quoted && (
        <details className="mt-3">
          <summary className="inline-flex cursor-pointer list-none rounded border bg-muted px-2 text-xs leading-5 text-muted-foreground hover:bg-muted/70" title="Show trimmed content">
            •••
          </summary>
          <div className="mt-2 border-l-2 pl-3 whitespace-pre-line text-muted-foreground">{linkify(quoted)}</div>
        </details>
      )}
    </div>
  );
}

/** SPEC §9.1 review queue, laid out like a mail app: message list on the left, the open message on the right. */
export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const now = new Date();
  const { items, jobs, total, toApprove } = await user.db(async (tx) => ({
    items: await tx
      .select({
        id: s.activities.id,
        type: s.activities.type,
        subject: s.activities.subject,
        snippet: sql<string | null>`left(${s.activities.body}, 240)`,
        fromAddress: s.activities.fromAddress,
        fromName: sql<string | null>`${s.activities.raw}->'email'->'from'->>'name'`,
        occurredAt: s.activities.occurredAt,
        triageStatus: s.activities.triageStatus,
        sensitive: s.activities.sensitive,
        attachmentCount: sql<number>`coalesce(jsonb_array_length(${s.activities.attachments}), 0)`.mapWith(Number),
        hasGuess: sql<boolean>`${s.activities.aiClassification} ? 'category'`,
        contact: { id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName },
      })
      .from(s.activities)
      .leftJoin(s.contacts, eq(s.contacts.id, s.activities.contactId))
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

  const header = (
    <PageHeader
      title="Messages"
      description="Messages that still need a person: file each one under a category and a job."
      actions={<QueueTabs active="inbox" toFile={total} toApprove={toApprove} />}
    />
  );
  if (items.length === 0)
    return (
      <>
        {header}
        <EmptyState>All caught up — nothing to file.</EmptyState>
      </>
    );

  // An explicit ?id= opens that message (and, on a phone, shows only the message); otherwise the newest.
  // `at` is its place in the list: once it's filed and gone, the message that moved up into that
  // place opens instead, so filing works through the list like archiving in a mail app.
  const requested = typeof sp.id === "string" ? sp.id : null;
  const at = Number(typeof sp.at === "string" ? sp.at : 0) || 0;
  const found = requested ? items.findIndex((i) => i.id === requested) : 0;
  const index = found >= 0 ? found : Math.min(Math.max(0, at), items.length - 1);
  const explicit = Boolean(requested);
  const current = items[index];
  const href = (i: number) => `/inbox?id=${items[i].id}&at=${i}`;
  const prev = items[index - 1] ? href(index - 1) : null;
  const next = items[index + 1] ? href(index + 1) : null;

  const [open] = await user.db((tx) =>
    tx
      .select({ a: s.activities, contact: { id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName }, jobNumber: s.jobs.jobNumber })
      .from(s.activities)
      .leftJoin(s.contacts, eq(s.contacts.id, s.activities.contactId))
      .leftJoin(s.jobs, eq(s.jobs.id, s.activities.jobId))
      .where(eq(s.activities.id, current.id)),
  );
  const { a, contact, jobNumber } = open;
  const meta = ((a.raw as { email?: EmailMeta } | null)?.email ?? null) as EmailMeta | null;
  const sms = a.type === "SMS";
  const contactName = contact?.id && (contact.firstName || contact.lastName) ? personName(contact) : null;
  const fromLabel = (sms ? contactName : (meta?.from?.name ?? contactName)) ?? (a.fromAddress?.startsWith("+") ? formatPhone(a.fromAddress) : a.fromAddress) ?? "Unknown sender";
  const fromAddr = sms ? (a.fromAddress ? formatPhone(a.fromAddress) : null) : (meta?.from?.address ?? a.fromAddress);
  // Pictures load automatically from people already in the CRM; from anyone else, on request.
  const images = sp.images === "1" || Boolean(contact?.id);
  const email = !sms && !a.sensitive && a.bodyHtml ? emailDocument(a.bodyHtml, { images }) : null;
  const attachments = (a.attachments ?? []).map((att, i) => ({ ...att, i })).filter((att) => !att.ownerOnly || user.role === "OWNER");
  const ai = a.aiClassification as (Partial<Triage> & { error?: string; blocked?: string }) | null;
  const guess = ai && !ai.blocked && !ai.error && ai.category ? ai : null;
  const job = a.jobId ? jobs.find((j) => j.id === a.jobId) : suggestJob(guess?.job_match_hints, jobs);
  const review = reviewActivity.bind(null, a.id);
  const recipients = meta ? [...meta.to.map((r) => who(r)), ...meta.cc.map((r) => `${who(r)} (cc)`)] : a.toAddress ? [a.toAddress] : [];

  return (
    <>
      {header}
      <div className="grid overflow-hidden rounded-xl border bg-background lg:grid-cols-[22rem_minmax(0,1fr)]">
        {/* ---------- message list ---------- */}
        <nav aria-label="Messages to file" className={cn("min-w-0 border-r lg:block", explicit && "hidden")}>
          <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
            <span>{total > items.length ? `Newest ${items.length} of ${total}` : `${total} to file`}</span>
            <span className="hidden lg:inline">
              <kbd className="rounded border bg-muted px-1 font-mono">J</kbd> <kbd className="rounded border bg-muted px-1 font-mono">K</kbd> to move
            </span>
          </div>
          <ul className="divide-y lg:max-h-[calc(100dvh-12rem)] lg:overflow-y-auto">
            {items.map((m, i) => {
              const name = (m.type === "SMS" ? null : m.fromName) ?? (m.contact?.id ? personName(m.contact) : null) ?? (m.fromAddress?.startsWith("+") ? formatPhone(m.fromAddress) : m.fromAddress) ?? "Unknown";
              const active = m.id === current.id;
              return (
                <li key={m.id}>
                  <Link
                    href={href(i)}
                    scroll={false}
                    data-inbox-item
                    aria-current={active ? "true" : undefined}
                    className={cn("flex gap-3 px-3 py-2.5 hover:bg-muted/60", active && "bg-sidebar-accent hover:bg-sidebar-accent lg:shadow-[inset_3px_0_0_var(--color-primary)]")}
                  >
                    <Avatar name={name} className="mt-0.5 size-8 text-xs" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-semibold">{name}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{listTime(m.occurredAt, now)}</span>
                      </span>
                      <span className="flex items-center gap-1 text-sm">
                        {m.type === "SMS" && <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-label="Text message" />}
                        <span className="truncate">{m.sensitive ? "AIRnyc — protected" : m.type === "SMS" ? "Text message" : m.subject || "(no subject)"}</span>
                        {m.attachmentCount > 0 && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{m.sensitive ? "Open to reveal (logged)." : splitQuoted(m.snippet ?? "").main.replace(/\s+/g, " ").trim() || "(no text)"}</span>
                      {(m.hasGuess || m.triageStatus === "BLOCKED") && (
                        <span className="mt-1 flex gap-1">
                          {m.hasGuess && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">Suggestion ready</Badge>}
                          {m.triageStatus === "BLOCKED" && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">AIRnyc</Badge>}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ---------- open message ---------- */}
        <article aria-label="Open message" className={cn("min-w-0 lg:block", !explicit && "hidden")}>
          <div className="flex items-center gap-1 border-b px-3 py-1.5">
            <Link href="/inbox" className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "lg:hidden")}>
              <ArrowLeft /> All messages
            </Link>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {index + 1} of {items.length}
            </span>
            {prev ? (
              <Link href={prev} scroll={false} className={buttonVariants({ size: "icon-sm", variant: "ghost" })} aria-label="Newer message (K)">
                <ChevronLeft />
              </Link>
            ) : (
              <span className={cn(buttonVariants({ size: "icon-sm", variant: "ghost" }), "opacity-40")} aria-hidden>
                <ChevronLeft />
              </span>
            )}
            {next ? (
              <Link href={next} scroll={false} className={buttonVariants({ size: "icon-sm", variant: "ghost" })} aria-label="Older message (J)">
                <ChevronRight />
              </Link>
            ) : (
              <span className={cn(buttonVariants({ size: "icon-sm", variant: "ghost" }), "opacity-40")} aria-hidden>
                <ChevronRight />
              </span>
            )}
          </div>

          <div className="space-y-4 p-4 sm:p-6">
            <div className="flex flex-wrap items-start gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold break-words">{a.sensitive ? "AIRnyc — protected" : sms ? "Text message" : a.subject || "(no subject)"}</h2>
              <div className="flex flex-wrap gap-1">
                {a.triageStatus === "BLOCKED" && <Badge variant="outline">AIRnyc · AI not allowed</Badge>}
                {a.triageStatus === "NEEDS_REVIEW" && <Badge variant="destructive">AI wasn&apos;t sure</Badge>}
                {jobNumber && (
                  <Link href={`/jobs/${a.jobId}`}>
                    <Badge variant="secondary" className="font-mono">{jobNumber}</Badge>
                  </Link>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Avatar name={fromLabel} className="size-10 text-sm" />
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{fromLabel}</span>
                  {fromAddr && fromAddr !== fromLabel && <span className="text-xs text-muted-foreground">&lt;{fromAddr}&gt;</span>}
                  {contact?.id ? (
                    <Link href={`/contacts/${contact.id}`} className="text-xs text-primary hover:underline">
                      View contact
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">· not in contacts</span>
                  )}
                </div>
                <time dateTime={a.occurredAt.toISOString()} className="block text-xs text-muted-foreground sm:hidden">
                  {fullTime(a.occurredAt, now)}
                </time>
                {recipients.length > 0 && (
                  <div className="truncate text-xs text-muted-foreground" title={recipients.join(", ")}>
                    to {recipients.join(", ")}
                  </div>
                )}
              </div>
              <time dateTime={a.occurredAt.toISOString()} className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
                {fullTime(a.occurredAt, now)}
              </time>
            </div>

            {email && email.blockedImages > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-xs">
                <ImageOff className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-muted-foreground">Pictures are hidden because this sender isn&apos;t in your contacts (they can be used to track that you opened it).</span>
                <Link href={`${href(index)}&images=1`} scroll={false} className="font-medium text-primary hover:underline">
                  Show pictures
                </Link>
              </div>
            )}

            <div className={cn(!sms && "sm:pl-[3.25rem]")}>
              {a.sensitive ? (
                <RevealSensitive activityId={a.id} />
              ) : sms ? (
                <div className="max-w-prose rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-sm whitespace-pre-line">{a.body || "(no text)"}</div>
              ) : email ? (
                <EmailFrame key={`${a.id}:${images}`} doc={email.doc} title={`Email: ${a.subject ?? "no subject"}`} />
              ) : (
                <EmailText text={a.body ?? ""} />
              )}
            </div>

            {attachments.length > 0 && (
              <div className="space-y-1.5 sm:pl-[3.25rem]">
                <div className="text-xs font-medium text-muted-foreground">
                  {attachments.length} attachment{attachments.length > 1 ? "s" : ""}
                </div>
                <div className="flex flex-wrap gap-2">
                  {attachments.map((att) => (
                    <a
                      key={att.i}
                      href={att.documentId ? `/api/documents/${att.documentId}` : `/api/activities/${a.id}/attachments/${att.i}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex max-w-64 items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted"
                    >
                      <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{att.filename}</span>
                        <span className="text-muted-foreground">{fileSize(att.size)}</span>
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {ai?.error && <p className="text-xs text-destructive">AI error: {ai.error}</p>}

            {/* ---------- filing ---------- */}
            <section aria-label="File this message" className="space-y-3 rounded-lg border bg-sidebar/60 p-3">
              {guess && (
                <FileForm action={review} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-primary/25 bg-background p-3">
                  <input type="hidden" name="category" value={guess.category} />
                  {job && <input type="hidden" name="jobId" value={job.id} />}
                  <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1 text-sm">
                    <div>
                      <span className="font-semibold text-primary">Suggested: {titleCase(guess.category!)}</span>
                      {job && (
                        <span>
                          {" "}
                          · file under <span className="font-mono text-xs">{job.jobNumber}</span>
                          {job.address ? ` (${job.address})` : ""}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground"> · {Math.round((guess.confidence ?? 0) * 100)}% sure</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {guess.service_code && `${label(SERVICE_LABELS, guess.service_code)} · `}
                      {guess.urgency && guess.urgency !== "NORMAL" && `${guess.urgency.toLowerCase()} · `}
                      {guess.summary}
                    </div>
                  </div>
                  <span data-accept>
                    <SubmitButton size="sm">Accept (A)</SubmitButton>
                  </span>
                </FileForm>
              )}
              <FileForm action={review} className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{guess ? "Or file it yourself:" : "File it:"}</span>
                <NativeSelect name="category" defaultValue={a.triageCategory ?? guess?.category ?? ""} className="w-44" aria-label="Category">
                  <option value="">— category —</option>
                  {TRIAGE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </NativeSelect>
                <JobPicker jobs={jobs} defaultJobId={a.jobId} className="w-full sm:w-72" />
                <SubmitButton size="sm" variant={guess ? "outline" : "default"}>
                  File
                </SubmitButton>
              </FileForm>
              <p className="text-xs text-muted-foreground">
                Filing takes it out of this list and opens the next message. Nothing is sent to the sender. Shortcuts: <kbd className="rounded border bg-muted px-1 font-mono">/</kbd> find a job
                {guess && (
                  <>
                    , <kbd className="rounded border bg-muted px-1 font-mono">A</kbd> accept
                  </>
                )}
                .
              </p>
            </section>
          </div>
        </article>
      </div>
      <InboxKeys prevHref={prev} nextHref={next} />
    </>
  );
}
