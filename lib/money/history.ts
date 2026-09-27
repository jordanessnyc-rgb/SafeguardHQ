/**
 * FreshBooks invoice history → CRM (Phase 7a). Every past invoice is cached for A/R and revenue
 * reports, and each sent invoice becomes a Closed job on the client's building so every client,
 * company and building shows its real history. Idempotent: re-running skips invoices that already
 * have a job, and refreshes the cached amounts.
 *
 * Imported jobs are deliberately quiet: they're Closed (terminal, never "stale"), already marked
 * paid when FreshBooks says so (no review-request drafts), and their compliance cycle is marked
 * handled so adding a compliance rule later doesn't flood the task list with old jobs.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import type { FbInvoice, FreshBooksClient } from "@/lib/integrations/freshbooks";
import { money, upsertInvoiceCache } from "./invoicing";

type ServiceCode = (typeof s.serviceCodeEnum.enumValues)[number];

/** Most specific first. Matched against the invoice's line names/descriptions and notes. */
const SERVICE_PATTERNS: [ServiceCode, RegExp][] = [
  ["AIRNYC", /\bairnyc\b|\bscn\b/i],
  ["LL152", /\bll\s?152\b|local law 152|gas pip/i],
  ["LL126", /\bll\s?126\b|local law 126|parapet/i],
  ["LL31", /\bll\s?31\b|local law 31/i],
  ["LEAD_WATER", /lead\b.*\bwater|water\b.*\blead|drinking water/i],
  ["LEAD_CLEAR", /dust wipe|lead\b.*\bclearance|clearance\b.*\blead/i],
  ["MOLD_CLEAR", /post[- ]?remediation|clearance|\bprv\b|\bpra\b/i],
  ["MOLD_PLAN", /work ?plan|remediation plan|protocol|scope of work/i],
  ["ASB_SURVEY", /asbestos|\bacm\b|\bacp[- ]?\d|\bplm\b/i],
  ["LEAD_RA", /\blead\b|\bxrf\b|risk assessment/i],
  ["VIOLATION", /violation|\bhpd\b|\bdob\b|\becb\b|\boath\b/i],
  ["MOLD_ASSESS", /mold|mould|fungal|microbial|spore|air sampl|moisture|indoor air/i],
];

export function guessServiceCode(inv: Pick<FbInvoice, "lines" | "notes">): { code: ServiceCode; guessed: boolean } {
  const text = [...(inv.lines ?? []).flatMap((l) => [l.name, l.description]), inv.notes].filter(Boolean).join("\n");
  for (const [code, re] of SERVICE_PATTERNS) if (re.test(text)) return { code, guessed: false };
  return { code: "MOLD_ASSESS", guessed: true };
}

/** "2024-03-05" → noon New York that day (avoids the date shifting across midnight in UTC). */
const nyNoon = (d: string) => new Date(`${d}T12:00:00-05:00`);

export type HistoryCounts = { invoices: number; jobsCreated: number; payments: number };

export async function importInvoiceHistory(db: Db, fb: FreshBooksClient, onProgress?: (c: HistoryCounts) => Promise<void>): Promise<HistoryCounts> {
  const counts: HistoryCounts = { invoices: 0, jobsCreated: 0, payments: 0 };
  const clients = new Map(
    (
      await db
        .select({ id: s.freshbooksClients.freshbooksClientId, orgId: s.freshbooksClients.linkedOrgId, contactId: s.freshbooksClients.linkedContactId, propertyId: s.freshbooksClients.propertyId })
        .from(s.freshbooksClients)
    ).map((c) => [c.id, c]),
  );
  const pipelineFor = new Map<string, string>();
  for (const p of await db.select().from(s.pipelines)) for (const code of p.serviceCodes) pipelineFor.set(code, p.key);

  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await fb.listInvoices(page);
    pages = r.pages;
    for (const inv of r.invoices) {
      counts.invoices++;
      const client = inv.customerid != null ? clients.get(String(inv.customerid)) : undefined;
      await upsertInvoiceCache(db, inv, null, client?.orgId ?? null);
      if (await createHistoricalJob(db, inv, client, pipelineFor)) counts.jobsCreated++;
    }
    await onProgress?.(counts);
  }

  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await fb.listPayments(page);
    pages = r.pages;
    for (const p of r.payments) {
      const invoiceId = p.invoiceid != null ? String(p.invoiceid) : null;
      const [fin] = invoiceId ? await db.select({ jobId: s.jobFinancials.jobId }).from(s.jobFinancials).where(eq(s.jobFinancials.freshbooksInvoiceId, invoiceId)) : [];
      const values = {
        freshbooksPaymentId: String(p.id),
        freshbooksInvoiceId: invoiceId,
        jobId: fin?.jobId ?? null,
        amount: money(p.amount),
        paidOn: p.date ?? null,
        type: p.type ?? null,
        deleted: p.vis_state === 1,
        raw: p as unknown as Record<string, unknown>,
      };
      await db.insert(s.paymentsCache).values(values).onConflictDoUpdate({ target: s.paymentsCache.freshbooksPaymentId, set: { ...values, updatedAt: new Date() } });
      counts.payments++;
    }
    await onProgress?.(counts);
  }
  return counts;
}

async function createHistoricalJob(
  db: Db,
  inv: FbInvoice,
  client: { orgId: string | null; contactId: string | null; propertyId: string | null } | undefined,
  pipelineFor: Map<string, string>,
): Promise<boolean> {
  // Drafts aren't billed yet and deleted invoices never happened; both stay out of the job list.
  if (inv.vis_state === 1 || (inv.v3_status ?? "draft") === "draft" || !inv.create_date) return false;
  const invoiceId = String(inv.id);
  const [linked] = await db.select({ jobId: s.jobFinancials.jobId }).from(s.jobFinancials).where(eq(s.jobFinancials.freshbooksInvoiceId, invoiceId));
  if (linked) return false;

  const { code, guessed } = guessServiceCode(inv);
  const number = inv.invoice_number || invoiceId;
  const when = nyNoon(inv.create_date);
  const firstLine = inv.lines?.find((l) => l.name?.trim())?.name?.trim();
  const paid = inv.payment_status === "paid" || inv.v3_status === "paid" || inv.v3_status === "auto-paid" || inv.v3_status === "autopaid";
  const lineItems = (inv.lines ?? [])
    .filter((l) => l.name?.trim() || l.description?.trim())
    .map((l) => ({ description: (l.name?.trim() || l.description!.trim()).slice(0, 300), quantity: Number(l.qty ?? 1) || 1, unitPrice: Number(l.unit_cost?.amount ?? 0) }));

  await db.transaction(async (tx) => {
    // Invoice numbers are unique per FreshBooks account; fall back to the id if one was reused.
    const [taken] = await tx.select({ id: s.jobs.id }).from(s.jobs).where(eq(s.jobs.jobNumber, `FB-${number}`));
    const [job] = await tx
      .insert(s.jobs)
      .values({
        jobNumber: taken ? `FB-${number}-${invoiceId}` : `FB-${number}`,
        serviceCode: code,
        pipelineKey: pipelineFor.get(code) ?? "INSPECTION",
        stage: "CLOSED",
        title: firstLine ? firstLine.slice(0, 200) : `FreshBooks invoice ${number}`,
        propertyId: client?.propertyId ?? null,
        clientOrgId: client?.orgId ?? null,
        clientContactId: client?.contactId ?? null,
        deliveredAt: when,
        cycleScheduledAt: new Date(),
        notes: `Imported from FreshBooks invoice ${number} (${inv.create_date}).${guessed ? " Service type is a guess — the invoice didn't say; change it if it's wrong." : ""}`,
        createdAt: when,
      })
      .returning({ id: s.jobs.id });
    // The stage trigger stamps "now"; history should read as when it happened.
    await tx.update(s.jobs).set({ stageEnteredAt: when }).where(eq(s.jobs.id, job.id));
    await tx
      .update(s.activities)
      .set({ occurredAt: when, subject: `Imported from FreshBooks invoice ${number}` })
      .where(and(eq(s.activities.jobId, job.id), eq(s.activities.type, "STAGE_CHANGE")));
    await tx.insert(s.jobFinancials).values({
      jobId: job.id,
      quotedAmount: money(inv.amount),
      lineItems,
      freshbooksInvoiceId: invoiceId,
      invoiceStatus: inv.v3_status ?? null,
      amountPaid: money(inv.paid),
      paidAt: paid ? (inv.date_paid ? nyNoon(inv.date_paid) : when) : null,
    });
    await tx
      .update(s.invoicesCache)
      .set({ jobId: job.id })
      .where(and(eq(s.invoicesCache.freshbooksInvoiceId, invoiceId), isNull(s.invoicesCache.jobId)));
  });
  return true;
}

/**
 * Worker entry point: runs the import once per request from Settings → FreshBooks. The claim is a
 * single conditional UPDATE, so two worker instances can't run it at the same time.
 */
export async function runRequestedHistoryImport(db: Db, fb: FreshBooksClient): Promise<HistoryCounts | null> {
  const startedAt = new Date().toISOString();
  const [claimed] = await db
    .update(s.freshbooksConnection)
    .set({ historyStatus: { startedAt, invoices: 0, jobsCreated: 0, payments: 0 } })
    .where(
      and(
        eq(s.freshbooksConnection.id, 1),
        sql`${s.freshbooksConnection.historyRequestedAt} is not null`,
        sql`(${s.freshbooksConnection.historyStatus} is null or (${s.freshbooksConnection.historyStatus}->>'startedAt')::timestamptz < ${s.freshbooksConnection.historyRequestedAt})`,
      ),
    )
    .returning({ id: s.freshbooksConnection.id });
  if (!claimed) return null;

  const save = (c: HistoryCounts, extra: { finishedAt?: string; error?: string } = {}) =>
    db.update(s.freshbooksConnection).set({ historyStatus: { startedAt, ...c, ...extra } }).where(eq(s.freshbooksConnection.id, 1));
  let last: HistoryCounts = { invoices: 0, jobsCreated: 0, payments: 0 };
  try {
    const counts = await importInvoiceHistory(db, fb, async (c) => {
      last = { ...c };
      await save(last);
    });
    await save(counts, { finishedAt: new Date().toISOString() });
    return counts;
  } catch (e) {
    await save(last, { finishedAt: new Date().toISOString(), error: (e as Error).message.slice(0, 500) });
    throw e;
  }
}
