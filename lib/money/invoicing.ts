/**
 * Job ↔ FreshBooks invoicing (SPEC §6.2):
 *  - Delivered → DRAFT invoice (property address + line items from job_financials). Sent only when
 *    settings.auto_create_invoice is on (CLAUDE.md rule 6); otherwise Jordan sends it from FreshBooks.
 *  - Invoice/payment webhooks → re-fetch from FreshBooks → update invoices_cache / job_financials.
 *    Sent → job Invoiced; fully paid → job Paid, review-request draft + task, held report released.
 * Everything runs on the privileged connection (worker/webhooks) and is idempotent.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import type { FbInvoice, FbPayment, FreshBooksClient } from "@/lib/integrations/freshbooks";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import { createDraft } from "@/lib/comms/outbound";
import { renderTemplate, BRAND_INFO } from "@/lib/comms/templates";
import { nyDate } from "./digest";

type LineItem = { description: string; quantity: number; unitPrice: number };

const money = (v: { amount?: string } | undefined | null) => (v?.amount != null ? Number(v.amount).toFixed(2) : null);

async function ownerIds(db: Db) {
  const rows = await db.select({ id: s.profiles.userId }).from(s.profiles).where(eq(s.profiles.role, "OWNER"));
  return rows.length ? rows.map((r) => r.id) : [null];
}

async function ownerTask(db: Db, t: { title: string; description?: string; jobId?: string | null; contactId?: string | null }) {
  const owners = await ownerIds(db);
  await db.insert(s.tasks).values(owners.map((assignee) => ({ ...t, assignee, source: "SYSTEM_RULE" as const, dueAt: new Date(Date.now() + 24 * 3600_000) })));
}

/** The CRM's billing party for a job → FreshBooks client id (links or creates, never duplicates by email). */
export async function ensureFreshbooksClient(db: Db, fb: FreshBooksClient, job: { clientOrgId: string | null; clientContactId: string | null }): Promise<string> {
  const [org] = job.clientOrgId ? await db.select().from(s.organizations).where(eq(s.organizations.id, job.clientOrgId)) : [];
  const [contact] = job.clientContactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, job.clientContactId)) : [];
  if (org?.freshbooksClientId) return org.freshbooksClientId;
  if (!org && contact?.freshbooksClientId) return contact.freshbooksClientId;
  if (!org && !contact) throw new Error("The job has no client organization or contact to bill.");

  const email = org?.email ?? contact?.emails[0] ?? null;
  const existing = email ? await fb.findClientByEmail(email) : null;
  const client =
    existing ??
    (await fb.createClient({
      organization: org?.name ?? null,
      fname: contact?.firstName ?? null,
      lname: contact?.lastName ?? null,
      email,
    }));
  const id = String(client.id);
  if (org) await db.update(s.organizations).set({ freshbooksClientId: id }).where(eq(s.organizations.id, org.id));
  else await db.update(s.contacts).set({ freshbooksClientId: id }).where(eq(s.contacts.id, contact!.id));
  return id;
}

export function invoiceLines(serviceCode: string, fin: { lineItems: LineItem[]; quotedAmount: string | null }, address: string | null) {
  if (fin.lineItems.length) {
    return fin.lineItems.map((l) => ({ type: 0, name: l.description.slice(0, 200), qty: l.quantity, unit_cost: { amount: l.unitPrice.toFixed(2), code: "USD" } }));
  }
  if (fin.quotedAmount && Number(fin.quotedAmount) > 0) {
    return [{ type: 0, name: label(SERVICE_LABELS, serviceCode), description: address ?? "", qty: 1, unit_cost: { amount: Number(fin.quotedAmount).toFixed(2), code: "USD" } }];
  }
  return [];
}

export type InvoiceOutcome = { status: "created" | "exists" | "skipped" | "error"; invoiceId?: string; reason?: string };

/** Creates the FreshBooks draft for a Delivered job. Safe to retry: it never creates a second invoice. */
export async function createDraftInvoiceForJob(db: Db, fb: FreshBooksClient, jobId: string): Promise<InvoiceOutcome> {
  const [row] = await db
    .select({ job: s.jobs, fin: s.jobFinancials, address: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough, zip: s.properties.zip })
    .from(s.jobs)
    .leftJoin(s.jobFinancials, eq(s.jobFinancials.jobId, s.jobs.id))
    .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
    .where(eq(s.jobs.id, jobId));
  if (!row) return { status: "skipped", reason: "job not found" };
  if (row.fin?.freshbooksInvoiceId) return { status: "exists", invoiceId: row.fin.freshbooksInvoiceId };

  const fail = async (reason: string): Promise<InvoiceOutcome> => {
    const first = !row.fin?.invoiceError;
    await db
      .insert(s.jobFinancials)
      .values({ jobId, invoiceError: reason })
      .onConflictDoUpdate({ target: s.jobFinancials.jobId, set: { invoiceError: reason } });
    if (first) await ownerTask(db, { title: `Couldn't draft the FreshBooks invoice for ${row.job.jobNumber}`, description: reason, jobId });
    return { status: "error", reason };
  };

  const address = row.address ? `${row.address}${row.unit ? `, Apt ${row.unit}` : ""}${row.borough ? `, ${row.borough}` : ""}${row.zip ? ` ${row.zip}` : ""}` : null;
  const lines = invoiceLines(row.job.serviceCode, { lineItems: row.fin?.lineItems ?? [], quotedAmount: row.fin?.quotedAmount ?? null }, address);
  if (!lines.length) return fail("No line items or quoted amount on the job's financials. Add them, then retry.");

  // Claim the attempt atomically so the worker loop and a stage move can't both create an invoice.
  // (A row exists here: invoice lines come from job_financials.)
  const claimed = await db
    .update(s.jobFinancials)
    .set({ invoiceAttemptAt: new Date() })
    .where(
      and(
        eq(s.jobFinancials.jobId, jobId),
        isNull(s.jobFinancials.freshbooksInvoiceId),
        sql`(${s.jobFinancials.invoiceAttemptAt} is null or ${s.jobFinancials.invoiceAttemptAt} < now() - interval '2 minutes')`,
      ),
    )
    .returning({ jobId: s.jobFinancials.jobId });
  if (!claimed.length) return { status: "skipped", reason: "another attempt is in progress" };

  try {
    const customerId = await ensureFreshbooksClient(db, fb, row.job);
    const marker = `ESS job ${row.job.jobNumber}`;

    // Crash safety: if a previous attempt got as far as FreshBooks, find that invoice instead of making another.
    if (row.fin?.invoiceAttemptAt) {
      const prior = (await fb.listInvoicesForClient(customerId)).find((i) => i.vis_state !== 1 && (i.notes ?? "").includes(marker));
      if (prior) {
        await recordInvoice(db, jobId, prior);
        return { status: "exists", invoiceId: String(prior.id) };
      }
    }

    const [cfg] = await db.select().from(s.settings);
    const invoice = await fb.createInvoice({
      customerid: Number(customerId),
      create_date: nyDate(new Date()),
      due_offset_days: cfg?.invoicePaymentTermsDays ?? 30,
      currency_code: "USD",
      lines,
      notes: [marker, address && `Service address: ${address}`, label(SERVICE_LABELS, row.job.serviceCode)].filter(Boolean).join("\n"),
    });
    await recordInvoice(db, jobId, invoice);

    if (cfg?.autoCreateInvoice) {
      const recipients = await billingEmails(db, row.job);
      if (recipients.length) await fb.emailInvoice(String(invoice.id), recipients);
    }
    return { status: "created", invoiceId: String(invoice.id) };
  } catch (e) {
    return fail((e as Error).message.slice(0, 500));
  }
}

async function billingEmails(db: Db, job: { clientOrgId: string | null; clientContactId: string | null }) {
  const [org] = job.clientOrgId ? await db.select({ email: s.organizations.email }).from(s.organizations).where(eq(s.organizations.id, job.clientOrgId)) : [];
  const [c] = job.clientContactId ? await db.select({ emails: s.contacts.emails }).from(s.contacts).where(eq(s.contacts.id, job.clientContactId)) : [];
  return [...new Set([org?.email, c?.emails[0]].filter((x): x is string => Boolean(x)))];
}

async function recordInvoice(db: Db, jobId: string, inv: FbInvoice) {
  await db
    .insert(s.jobFinancials)
    .values({ jobId, freshbooksInvoiceId: String(inv.id), invoiceStatus: inv.v3_status ?? "draft", invoiceError: null })
    .onConflictDoUpdate({ target: s.jobFinancials.jobId, set: { freshbooksInvoiceId: String(inv.id), invoiceStatus: inv.v3_status ?? "draft", invoiceError: null } });
  await upsertInvoiceCache(db, inv, jobId);
}

async function upsertInvoiceCache(db: Db, inv: FbInvoice, jobId: string | null) {
  const values = {
    freshbooksInvoiceId: String(inv.id),
    jobId,
    invoiceNumber: inv.invoice_number ?? null,
    freshbooksClientId: inv.customerid != null ? String(inv.customerid) : null,
    status: inv.vis_state === 1 ? "deleted" : (inv.v3_status ?? null),
    amount: money(inv.amount),
    outstanding: money(inv.outstanding),
    paid: money(inv.paid),
    currency: inv.currency_code ?? inv.amount?.code ?? "USD",
    issuedAt: inv.create_date ?? null,
    dueAt: inv.due_date ?? null,
    fbUpdatedAt: inv.updated ? new Date(inv.updated.replace(" ", "T") + (inv.updated.includes("Z") || inv.updated.includes("+") ? "" : "Z")) : null,
    raw: inv as unknown as Record<string, unknown>,
  };
  await db
    .insert(s.invoicesCache)
    .values(values)
    .onConflictDoUpdate({
      target: s.invoicesCache.freshbooksInvoiceId,
      set: { ...values, jobId: sql`coalesce(${s.invoicesCache.jobId}, excluded.job_id)`, updatedAt: new Date() },
      // Never let an older snapshot overwrite a newer one (webhooks can arrive out of order).
      setWhere: sql`${s.invoicesCache.fbUpdatedAt} is null or excluded.fb_updated_at is null or excluded.fb_updated_at >= ${s.invoicesCache.fbUpdatedAt}`,
    });
}

const SENT = new Set(["sent", "viewed", "overdue", "partial", "disputed", "resolved", "pending", "failed", "retry", "declined"]);
const PAID = new Set(["paid", "autopaid", "success"]);

/** Re-fetch an invoice and apply it to the CRM. Returns the job it belongs to (if any). */
export async function syncInvoice(db: Db, fb: FreshBooksClient, invoiceId: string): Promise<string | null> {
  const inv = await fb.getInvoice(invoiceId);
  const [fin] = await db.select().from(s.jobFinancials).where(eq(s.jobFinancials.freshbooksInvoiceId, String(inv.id)));
  await upsertInvoiceCache(db, inv, fin?.jobId ?? null);
  if (!fin) return null; // an invoice made directly in FreshBooks — cached for A/R, not tied to a job

  const status = inv.vis_state === 1 ? "deleted" : (inv.v3_status ?? inv.payment_status ?? "unknown");
  const paidAmount = money(inv.paid);
  const fullyPaid = PAID.has(status) || (inv.payment_status === "paid") || (Number(money(inv.outstanding) ?? 1) === 0 && Number(paidAmount ?? 0) > 0);
  await db.update(s.jobFinancials).set({ invoiceStatus: status, amountPaid: paidAmount }).where(eq(s.jobFinancials.jobId, fin.jobId));

  const [job] = await db.select().from(s.jobs).where(eq(s.jobs.id, fin.jobId));
  if (!job) return null;
  if (fullyPaid) await onPaid(db, job, fin);
  else if (SENT.has(status) && job.stage === "DELIVERED") await db.update(s.jobs).set({ stage: "INVOICED" }).where(eq(s.jobs.id, job.id));
  return job.id;
}

/** Hold-until-paid resolves job flag → client organization flag → settings default. */
export async function reportHeld(
  conn: Db | Tx,
  job: { clientOrgId: string | null },
  fin: { holdReportUntilPaid: boolean | null } | null | undefined,
): Promise<boolean> {
  if (fin?.holdReportUntilPaid != null) return fin.holdReportUntilPaid;
  const [org] = job.clientOrgId ? await conn.select({ hold: s.organizations.holdReportUntilPaid }).from(s.organizations).where(eq(s.organizations.id, job.clientOrgId)) : [];
  if (org?.hold != null) return org.hold;
  const [cfg] = await conn.select({ hold: s.settings.holdReportUntilPaidDefault }).from(s.settings);
  return cfg?.hold ?? false;
}

async function onPaid(db: Db, job: typeof s.jobs.$inferSelect, fin: typeof s.jobFinancials.$inferSelect) {
  // Idempotency gate: only the first time we see this job paid.
  const [claimed] = await db
    .update(s.jobFinancials)
    .set({ paidAt: new Date() })
    .where(and(eq(s.jobFinancials.jobId, job.id), isNull(s.jobFinancials.paidAt)))
    .returning();
  if (!claimed) return;

  if (["DELIVERED", "INVOICED"].includes(job.stage)) await db.update(s.jobs).set({ stage: "PAID" }).where(eq(s.jobs.id, job.id));

  // Held report → released on payment (SPEC §6.2 "hold report until paid").
  const held = await reportHeld(db, job, fin);
  if (held && !fin.reportReleasedAt) {
    await db.update(s.jobFinancials).set({ reportReleasedAt: new Date() }).where(eq(s.jobFinancials.jobId, job.id));
    await ownerTask(db, { title: `Paid — release the report for ${job.jobNumber}`, description: "The report was held until payment. Send the final report to the client.", jobId: job.id, contactId: job.clientContactId });
  }

  // Review request: a DRAFT text in the Outbox (never auto-sent unless auto_send_sms) + a task.
  const [contact] = job.clientContactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, job.clientContactId)) : [];
  const [tpl] = await db.select().from(s.messageTemplates).where(and(eq(s.messageTemplates.key, "REVIEW_REQUEST"), eq(s.messageTemplates.active, true)));
  const [line] = await db.select().from(s.phoneLines).where(eq(s.phoneLines.brand, job.brand)).limit(1);
  if (contact && !contact.doNotContact && contact.phones[0] && tpl && line && process.env.REVIEW_URL) {
    const { text } = renderTemplate(tpl.body, { first_name: contact.firstName, brand_name: BRAND_INFO[job.brand].name, review_url: process.env.REVIEW_URL });
    await createDraft(db, { channel: "SMS", source: "TEMPLATE", templateKey: "REVIEW_REQUEST", toAddress: contact.phones[0], fromLineId: line.id, body: text, brand: job.brand, contactId: contact.id, jobId: job.id });
  }
  await db.insert(s.tasks).values({
    title: `Ask ${contact ? personName(contact) : "the client"} for a review — ${job.jobNumber} is paid`,
    description: contact && tpl && process.env.REVIEW_URL ? "A review-request text is waiting in the Outbox." : "Send a review request.",
    source: "SYSTEM_RULE",
    jobId: job.id,
    contactId: job.clientContactId,
    dueAt: new Date(Date.now() + 2 * 24 * 3600_000),
  });
}

export async function syncPayment(db: Db, fb: FreshBooksClient, paymentId: string): Promise<string | null> {
  const p: FbPayment = await fb.getPayment(paymentId);
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
  return invoiceId ? syncInvoice(db, fb, invoiceId) : null;
}

/**
 * Worker loop: every Delivered job without an invoice gets a draft (errors surface once as a task).
 * Only jobs delivered after FreshBooks was connected: older jobs may already have been billed by hand,
 * so those get a draft only when someone clicks "Create draft invoice" on the job.
 */
export async function invoiceDeliveredJobs(db: Db, fb: FreshBooksClient, limit = 10, onlyJobId?: string) {
  const [conn] = await db.select({ since: s.freshbooksConnection.createdAt }).from(s.freshbooksConnection);
  if (!conn) return [];
  const due = await db
    .select({ id: s.jobs.id })
    .from(s.jobs)
    .leftJoin(s.jobFinancials, eq(s.jobFinancials.jobId, s.jobs.id))
    .where(
      and(
        inArray(s.jobs.stage, ["DELIVERED"]),
        isNull(s.jobs.archivedAt),
        isNull(s.jobFinancials.freshbooksInvoiceId),
        gte(s.jobs.deliveredAt, conn.since),
        onlyJobId ? eq(s.jobs.id, onlyJobId) : undefined,
        // Failed attempts wait for a human fix (they get a task), but are retried hourly.
        sql`(${s.jobFinancials.invoiceError} is null or ${s.jobFinancials.updatedAt} < now() - interval '1 hour')`,
      ),
    )
    .limit(limit);
  const out: InvoiceOutcome[] = [];
  for (const j of due) out.push(await createDraftInvoiceForJob(db, fb, j.id));
  return out;
}
