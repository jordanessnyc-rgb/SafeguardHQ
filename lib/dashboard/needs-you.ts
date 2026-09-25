/**
 * The dashboard's "Needs you" list: everything waiting on a person, most urgent first, each with one
 * next step. Runs inside the caller's RLS transaction, so a VA never sees owner-only rows; money items
 * are only built for the owner (invoices are owner-only tables anyway).
 */
import { and, asc, count, eq, inArray, isNull, min, or, sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { expiringItems } from "@/lib/compliance/expiry";
import { addDays, upcomingCycles } from "@/lib/compliance/cycles";
import { arAging } from "@/lib/money/reports";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { daysInStage, isStale } from "@/lib/pipeline/rules";
import { inboxReviewWhere } from "@/lib/queues";
import { nyDate, TZ } from "@/lib/time";

export type NeedsKind = "approve" | "file" | "task" | "stale" | "lab" | "invoice" | "expiring" | "compliance" | "bid";

export type NeedsItem = {
  key: string;
  kind: NeedsKind;
  title: string;
  meta: string | null;
  /** Short "when" text (e.g. "Due today", "2 days over"). */
  when: string | null;
  late: boolean;
  href: string;
  action: string;
  /** Set for tasks: the dashboard renders a one-click Done button instead of a link. */
  taskId?: string;
  /** Lower sorts first. */
  rank: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(from: Date, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)} days`;
}

export async function buildNeedsYou(tx: Tx, opts: { userId: string; isOwner: boolean; now?: Date }): Promise<NeedsItem[]> {
  const now = opts.now ?? new Date();
  const today = nyDate(now);
  const items: NeedsItem[] = [];

  // --- Outbox: drafts waiting for approval, and failed sends ---
  const [out] = await tx
    .select({ n: count(), failed: sql<number>`count(*) filter (where ${s.outboundMessages.status} = 'FAILED')::int`, oldest: min(s.outboundMessages.createdAt) })
    .from(s.outboundMessages)
    .where(inArray(s.outboundMessages.status, ["DRAFT", "FAILED"]));
  if (out.n > 0)
    items.push({
      key: "outbox",
      kind: "approve",
      title: `${plural(out.n, "message")} waiting for your approval`,
      meta: out.failed ? `${out.failed} failed to send and need${out.failed === 1 ? "s" : ""} another look` : "Nothing goes to a client until you approve it",
      when: out.oldest ? `Oldest ${ago(out.oldest, now)}` : null,
      late: out.failed > 0,
      href: "/outbox",
      action: "Review",
      rank: out.failed ? 0 : 10,
    });

  // --- Inbox review ---
  const [inbox] = await tx
    .select({ n: count(), blocked: sql<number>`count(*) filter (where ${s.activities.triageStatus} = 'BLOCKED')::int`, oldest: min(s.activities.occurredAt) })
    .from(s.activities)
    .where(inboxReviewWhere);
  if (inbox.n > 0)
    items.push({
      key: "inbox",
      kind: "file",
      title: `${plural(inbox.n, "message")} to file`,
      meta: inbox.blocked ? `${inbox.blocked} AIRnyc (AI not allowed to read — needs a person)` : "The AI wasn't sure where these belong",
      when: inbox.oldest ? `Oldest ${ago(inbox.oldest, now)}` : null,
      late: false,
      href: "/inbox",
      action: "Start filing",
      rank: 20,
    });

  // --- My tasks (or unassigned) that are overdue or due today ---
  const tasks = await tx
    .select({ t: s.tasks, jobNumber: s.jobs.jobNumber })
    .from(s.tasks)
    .leftJoin(s.jobs, eq(s.jobs.id, s.tasks.jobId))
    .where(and(isNull(s.tasks.archivedAt), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]), or(eq(s.tasks.assignee, opts.userId), isNull(s.tasks.assignee)), sql`(${s.tasks.dueAt} at time zone ${TZ})::date <= ${today}`))
    .orderBy(asc(s.tasks.dueAt))
    .limit(8);
  for (const { t, jobNumber } of tasks) {
    const overdueDays = Math.floor((now.getTime() - t.dueAt!.getTime()) / 86_400_000);
    const late = nyDate(t.dueAt!) < today;
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      title: t.title,
      meta: jobNumber ?? null,
      when: late ? (overdueDays >= 1 ? `${plural(overdueDays, "day")} overdue` : "Overdue") : "Due today",
      late,
      href: t.jobId ? `/jobs/${t.jobId}` : t.propertyId ? `/properties/${t.propertyId}` : t.contactId ? `/contacts/${t.contactId}` : "/tasks",
      action: "Done",
      taskId: t.id,
      rank: late ? 5 : 30,
    });
  }

  // --- Stale jobs ---
  const stages = await tx.select().from(s.pipelineStages);
  const stageMap = new Map(stages.map((st) => [`${st.pipelineKey}:${st.key}`, st]));
  const open = await tx
    .select({ job: s.jobs, address: s.properties.addressLine })
    .from(s.jobs)
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .where(isNull(s.jobs.archivedAt));
  const stale = open
    .map(({ job, address }) => ({ job, address, st: stageMap.get(`${job.pipelineKey}:${job.stage}`) }))
    .filter(({ job, st }) => st && !st.isTerminal && isStale(job.stageEnteredAt, st.staleAfterDays, now))
    .map((r) => {
      const days = daysInStage(r.job.stageEnteredAt, now);
      return { ...r, days, over: days - (r.st!.staleAfterDays ?? 0) };
    })
    .sort((a, b) => b.over - a.over); // furthest past its limit first
  for (const { job, address, st, days, over } of stale.slice(0, 5)) {
    items.push({
      key: `stale:${job.id}`,
      kind: "stale",
      title: `${job.jobNumber} · ${label(SERVICE_LABELS, job.serviceCode)}`,
      meta: `${st!.name} for ${plural(days, "day")} (limit ${st!.staleAfterDays})${address ? ` · ${address}` : ""}`,
      when: over > 0 ? `${plural(over, "day")} over` : "At limit",
      late: true,
      href: `/jobs/${job.id}`,
      action: "Open job",
      rank: 40 - Math.min(over, 9),
    });
  }
  if (stale.length > 5)
    items.push({ key: "stale:more", kind: "stale", title: `${stale.length - 5} more stale jobs`, meta: null, when: null, late: false, href: "/jobs?view=list&stale=1&sort=days", action: "See all", rank: 41 });

  // --- Lab results in, waiting for review ---
  const lab = await tx
    .select({ jobId: s.jobs.id, jobNumber: s.jobs.jobNumber, n: sql<number>`count(*)::int` })
    .from(s.samples)
    .innerJoin(s.jobs, eq(s.jobs.id, s.samples.jobId))
    .where(and(eq(s.samples.status, "RESULTS_IN"), isNull(s.samples.archivedAt), isNull(s.jobs.archivedAt)))
    .groupBy(s.jobs.id, s.jobs.jobNumber)
    .limit(5);
  for (const l of lab)
    items.push({ key: `lab:${l.jobId}`, kind: "lab", title: `Lab results in for ${l.jobNumber}`, meta: plural(l.n, "sample"), when: null, late: false, href: `/jobs/${l.jobId}`, action: "Review", rank: 45 });

  // --- Owner: invoices more than 30 days past due ---
  if (opts.isOwner) {
    const ar = await arAging(tx, now);
    const late = ar.items.filter((i) => i.bucket === "31-60" || i.bucket === "61-90" || i.bucket === "90+").sort((a, b) => b.outstanding - a.outstanding);
    for (const i of late.slice(0, 3))
      items.push({
        key: `inv:${i.freshbooksInvoiceId}`,
        kind: "invoice",
        title: [`Invoice${i.invoiceNumber ? ` ${i.invoiceNumber}` : ""}`, i.jobNumber].filter(Boolean).join(" · ") + " unpaid",
        meta: `${i.client ?? "Client"} · ${i.outstanding.toLocaleString("en-US", { style: "currency", currency: "USD" })} outstanding`,
        when: `${i.bucket} days`,
        late: true,
        href: i.jobId ? `/jobs/${i.jobId}` : "/reports",
        action: "Open",
        rank: 50,
      });
  }

  // --- Licenses / sub insurance expiring within 30 days ---
  for (const e of (await expiringItems(tx, now, 30)).slice(0, 3))
    items.push({
      key: `exp:${e.type}:${e.id}`,
      kind: "expiring",
      title: e.name,
      meta: e.type === "SUB_COI" ? "Subcontractor insurance" : "License / credential",
      when: e.daysLeft < 0 ? `Expired ${-e.daysLeft} days ago` : e.daysLeft === 0 ? "Expires today" : `Expires in ${plural(e.daysLeft, "day")}`,
      late: e.daysLeft <= 7,
      href: e.href,
      action: "Open",
      rank: e.daysLeft < 0 ? 3 : 60,
    });

  // --- Compliance cycles coming due in the next 60 days (one summary row) ---
  const cycles = await upcomingCycles(tx, today, addDays(today, 60));
  if (cycles.length)
    items.push({
      key: "cycles",
      kind: "compliance",
      title: `${plural(cycles.length, "compliance cycle")} due in the next 60 days`,
      meta: [...new Set(cycles.map((c) => label(SERVICE_LABELS, c.serviceCode)))].slice(0, 3).join(" · "),
      when: `First due ${cycles[0].due}`,
      late: false,
      href: "/compliance",
      action: "Plan outreach",
      rank: 70,
    });

  // --- Bids due within 7 days ---
  const bids = await tx
    .select({ id: s.bids.id, title: s.bids.title, dueAt: s.bids.dueAt })
    .from(s.bids)
    .where(and(isNull(s.bids.archivedAt), inArray(s.bids.status, ["WATCHING", "GO_NO_GO", "DRAFTING"]), sql`${s.bids.dueAt} between ${now.toISOString()} and ${new Date(now.getTime() + 7 * 86_400_000).toISOString()}`))
    .orderBy(asc(s.bids.dueAt))
    .limit(3);
  for (const b of bids)
    items.push({ key: `bid:${b.id}`, kind: "bid", title: b.title, meta: "Government bid", when: `Due ${nyDate(b.dueAt!)}`, late: false, href: `/bids/${b.id}`, action: "Open bid", rank: 35 });

  return items.sort((a, b) => a.rank - b.rank);
}
