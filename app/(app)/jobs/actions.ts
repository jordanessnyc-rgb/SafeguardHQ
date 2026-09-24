"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { adminDb, schema as s } from "@/lib/db";
import { freshbooksFromEnv } from "@/lib/integrations/freshbooks";
import { createDraftInvoiceForJob, invoiceDeliveredJobs, syncInvoice } from "@/lib/money/invoicing";
import { computeQuote } from "@/lib/money/quote";
import { generateProposal } from "@/lib/docs/proposal";
import { createSubCopy } from "@/lib/docs/sub-copy-job";
import { storageDownloader, storageUploader } from "@/lib/supabase/service";
import { label, SERVICE_LABELS } from "@/lib/labels";
import { requireOwner, requireStaff } from "@/lib/auth/session";
import { checkbox, formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { pipelineForService } from "@/lib/pipeline/config";
import { ensureJobDriveFolder } from "@/lib/jobs/drive";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromNyInput } from "@/lib/time";

const dateTime = z
  .string()
  .optional()
  .transform((v) => (v ? fromNyInput(v) : undefined))
  .refine((d) => !d || !Number.isNaN(d.getTime()), "Invalid date");

const jobSchema = z.object({
  serviceCode: z.enum(s.serviceCodeEnum.enumValues),
  brand: z.enum(s.brandEnum.enumValues),
  propertyId: optionalUuid,
  clientOrgId: optionalUuid,
  clientContactId: optionalUuid,
  priority: z.enum(s.priorityEnum.enumValues),
  source: z.enum(s.contactSourceEnum.enumValues).optional(),
  title: z.string().max(200).optional(),
  scheduledAt: dateTime,
  assignedTo: optionalUuid,
  subOrgId: optionalUuid,
  hpdViolationRef: z.string().max(100).optional(),
  nextCycleDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(5000).optional(),
});

export async function createJob(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  let id: string | undefined;
  const res = await safeAction(async () => {
    const input = jobSchema.parse(formObject(form));
    id = await user.db(async (tx) => {
      const pipeline = await pipelineForService(tx, input.serviceCode);
      const [job] = await tx
        .insert(s.jobs)
        .values({ ...input, pipelineKey: pipeline.key, stage: pipeline.stages[0].key })
        .returning({ id: s.jobs.id });
      return job.id;
    });
    // Best effort: a Drive hiccup shouldn't lose the job. The job page offers a retry.
    await user.db((tx) => ensureJobDriveFolder(tx, id!)).catch((e) => console.error("Drive folder failed", e));
  });
  if (res.error || !id) return res;
  redirect(`/jobs/${id}`);
}

export async function updateJob(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = jobSchema.omit({ serviceCode: true }).parse(formObject(form));
    const nullable = Object.fromEntries(Object.keys(jobSchema.shape).map((k) => [k, null]));
    delete nullable.serviceCode;
    await user.db((tx) => tx.update(s.jobs).set({ ...nullable, ...input }).where(eq(s.jobs.id, id)));
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/jobs/${id}`);
  return res;
}

export async function moveJobStage(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const { stage, lostReason } = formObject(form);
  return setJobStage(id, stage ?? "", lostReason);
}

/** Used by the Kanban drag-and-drop and the stage form. The DB trigger enforces the rules. */
export async function setJobStage(id: string, stage: string, lostReason?: string): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    if (!stage) throw new Error("Pick a stage.");
    await user.db((tx) =>
      tx
        .update(s.jobs)
        .set({ stage, ...(stage === "LOST" ? { lostReason: lostReason ?? null } : {}) })
        .where(eq(s.jobs.id, id)),
    );
    // Draft the FreshBooks invoice right away rather than waiting for the worker's next pass.
    if (stage === "DELIVERED") {
      after(async () => {
        const fb = freshbooksFromEnv(adminDb());
        if (fb) await invoiceDeliveredJobs(adminDb(), fb, 1, id).catch((e) => console.error("[invoice]", e));
      });
    }
    return { ok: true, message: "Stage updated." };
  });
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/jobs");
  return res;
}

/** Owner: create (or retry) the FreshBooks draft invoice for this job. Never sends it unless auto-send is on. */
export async function createJobInvoice(jobId: string, _prev: ActionState): Promise<ActionState> {
  await requireOwner();
  const res = await safeAction(async () => {
    const fb = freshbooksFromEnv(adminDb());
    if (!fb) throw new Error("FreshBooks isn't set up on the server (see Settings → FreshBooks).");
    const out = await createDraftInvoiceForJob(adminDb(), fb, jobId);
    if (out.status === "error" || out.status === "skipped") return { error: out.reason ?? "Couldn't create the invoice." };
    return { ok: true, message: out.status === "created" ? "Draft invoice created in FreshBooks." : "This job already has an invoice." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

/** Owner: re-read the invoice from FreshBooks (status, payments). Same path as the webhook. */
export async function refreshJobInvoice(jobId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const fb = freshbooksFromEnv(adminDb());
    if (!fb) throw new Error("FreshBooks isn't set up on the server.");
    const [fin] = await user.db((tx) => tx.select({ inv: s.jobFinancials.freshbooksInvoiceId }).from(s.jobFinancials).where(eq(s.jobFinancials.jobId, jobId)));
    if (!fin?.inv) throw new Error("No invoice yet.");
    await syncInvoice(adminDb(), fb, fin.inv);
    return { ok: true, message: "Updated from FreshBooks." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

export async function createJobDriveFolder(id: string, _prev: ActionState): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const out = await user.db((tx) => ensureJobDriveFolder(tx, id));
    return out.skipped ? { error: out.skipped } : { ok: true, message: "Drive folder ready." };
  });
  revalidatePath(`/jobs/${id}`);
  return res;
}

export async function archiveJob(id: string) {
  const user = await requireStaff();
  await user.db((tx) => tx.update(s.jobs).set({ archivedAt: new Date() }).where(eq(s.jobs.id, id)));
  redirect("/jobs");
}

// --- Notes ---------------------------------------------------------------------------------

export async function addJobNote(jobId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const body = z.string().min(1, "Write something first").max(10000).parse(formObject(form).body);
    await user.db(async (tx) => {
      const [job] = await tx.select({ propertyId: s.jobs.propertyId, brand: s.jobs.brand, contactId: s.jobs.clientContactId }).from(s.jobs).where(eq(s.jobs.id, jobId));
      await tx.insert(s.activities).values({ type: "NOTE", direction: "INTERNAL", jobId, propertyId: job?.propertyId, contactId: job?.contactId, brand: job?.brand, body });
    });
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

// --- Samples -------------------------------------------------------------------------------

const sampleSchema = z.object({
  sampleId: z.string().min(1, "Sample ID is required").max(50),
  type: z.enum(s.sampleTypeEnum.enumValues),
  location: z.string().max(200).optional(),
  cocNumber: z.string().max(50).optional(),
  status: z.enum(s.sampleStatusEnum.enumValues),
});

export async function addSample(jobId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = sampleSchema.parse(formObject(form));
    await user.db((tx) =>
      tx.insert(s.samples).values({ jobId, ...input, submittedAt: input.status === "SUBMITTED" ? new Date() : undefined }),
    );
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

export async function setSampleStatus(jobId: string, sampleId: string, form: FormData) {
  const user = await requireStaff();
  const status = z.enum(s.sampleStatusEnum.enumValues).parse(form.get("status"));
  await user.db((tx) =>
    tx
      .update(s.samples)
      .set({
        status,
        ...(status === "SUBMITTED" ? { submittedAt: sql`coalesce(${s.samples.submittedAt}, now())` } : {}),
        ...(status === "RESULTS_IN" ? { resultsReceivedAt: sql`coalesce(${s.samples.resultsReceivedAt}, now())` } : {}),
      })
      .where(and(eq(s.samples.id, sampleId), eq(s.samples.jobId, jobId))),
  );
  revalidatePath(`/jobs/${jobId}`);
}

// --- Documents -----------------------------------------------------------------------------

const docSchema = z.object({
  kind: z.enum(s.documentKindEnum.enumValues),
  title: z.string().max(200).optional(),
  status: z.enum(s.documentStatusEnum.enumValues),
  containsPricing: checkbox,
});

export async function addDocument(jobId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = docSchema.parse({ ...formObject(form), containsPricing: form.get("containsPricing") });
    if (input.containsPricing && user.role !== "OWNER") throw new Error("Only the owner can add documents with pricing.");
    const file = form.get("file");
    let storage: { storageBucket: string; storagePath: string } | undefined;
    if (file instanceof File && file.size > 0) {
      // Priced documents live in an OWNER-only bucket (storage RLS), not just a hidden row.
      const bucket = input.containsPricing ? "job-files-pricing" : "job-files";
      const path = `jobs/${jobId}/${randomUUID()}-${file.name.replace(/[^\w.\- ]+/g, "_")}`;
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type || undefined });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      storage = { storageBucket: bucket, storagePath: path };
    }
    await user.db(async (tx) => {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.documents)
        .where(and(eq(s.documents.jobId, jobId), eq(s.documents.kind, input.kind)));
      await tx.insert(s.documents).values({ jobId, ...input, title: input.title ?? (file instanceof File ? file.name : undefined), version: n + 1, ...storage });
    });
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

export async function setDocumentStatus(jobId: string, docId: string, form: FormData) {
  const user = await requireStaff();
  const status = z.enum(s.documentStatusEnum.enumValues).parse(form.get("status"));
  await user.db((tx) => tx.update(s.documents).set({ status }).where(and(eq(s.documents.id, docId), eq(s.documents.jobId, jobId))));
  revalidatePath(`/jobs/${jobId}`);
}

// --- Financials (OWNER only — RLS enforces it too) ----------------------------------------

const money = z
  .string()
  .optional()
  .transform((v) => (v ? v.replace(/[$,\s]/g, "") : undefined))
  .refine((v) => v === undefined || /^\d+(\.\d{1,2})?$/.test(v), "Enter an amount like 1850 or 1850.00");

const lineItems = z
  .string()
  .optional()
  .transform((v, ctx) =>
    (v ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        // "Description | qty | unit price"
        const [description, qty, price] = l.split("|").map((x) => x.trim());
        const quantity = Number(qty ?? 1);
        const unitPrice = Number((price ?? "").replace(/[$,]/g, ""));
        if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
          ctx.addIssue({ code: "custom", message: `Line item "${l}" should look like: Description | 1 | 450.00` });
        }
        return { description, quantity, unitPrice };
      }),
  );

const finSchema = z.object({
  quotedAmount: money,
  subCost: money,
  labCost: money,
  otherCost: money,
  lineItems,
  // "" = inherit (client organization, then Settings default)
  holdReportUntilPaid: z
    .enum(["", "true", "false"])
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : null)),
});

export async function saveFinancials(jobId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const f = finSchema.parse(formObject(form));
    const values = {
      quotedAmount: f.quotedAmount ?? null,
      subCost: f.subCost ?? null,
      labCost: f.labCost ?? null,
      otherCost: f.otherCost ?? null,
      lineItems: f.lineItems,
      holdReportUntilPaid: f.holdReportUntilPaid,
    };
    await user.db((tx) =>
      tx.insert(s.jobFinancials).values({ jobId, ...values }).onConflictDoUpdate({ target: s.jobFinancials.jobId, set: values }),
    );
    return { ok: true, message: "Financials saved." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Quote builder, sub quotes, proposals and sub copies (SPEC §10) — OWNER only
// ---------------------------------------------------------------------------------------------

const quoteSchema = z.object({
  sqft: z.coerce.number().int().min(0).max(10_000_000).optional(),
  samples: z.coerce.number().int().min(0).max(1000).optional(),
  extras: lineItems,
  scope: z.string().max(5000).optional(),
  validDays: z.coerce.number().int().min(1).max(365).optional(),
});

/** Prices the job from Jordan's rule for its service; replaces the job's line items and quoted total. */
export async function buildQuote(jobId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = quoteSchema.parse(formObject(form));
    const inputs = { sqft: v.sqft ?? null, samples: v.samples ?? null, extras: v.extras, scope: v.scope ?? null, validDays: v.validDays ?? null };
    const note = await user.db(async (tx) => {
      const [job] = await tx.select({ serviceCode: s.jobs.serviceCode }).from(s.jobs).where(eq(s.jobs.id, jobId));
      if (!job) throw new Error("Job not found.");
      const [rule] = await tx.select().from(s.pricingRules).where(and(eq(s.pricingRules.serviceCode, job.serviceCode), eq(s.pricingRules.active, true)));
      const q = computeQuote(label(SERVICE_LABELS, job.serviceCode), rule ?? null, inputs);
      if (!q.lines.length) throw new Error("Nothing to price: add a pricing rule for this service (Settings → Pricing) or extra lines.");
      const values = { lineItems: q.lines, quotedAmount: q.total.toFixed(2), quoteInputs: inputs };
      await tx.insert(s.jobFinancials).values({ jobId, ...values }).onConflictDoUpdate({ target: s.jobFinancials.jobId, set: values });
      return q.notes.join(" ");
    });
    return { ok: true, message: `Quote updated.${note ? ` ${note}` : ""}` };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

export async function generateProposalDoc(jobId: string, _prev: ActionState): Promise<ActionState> {
  await requireOwner();
  const res = await safeAction(async () => {
    const r = await generateProposal(adminDb(), jobId, storageUploader());
    return { ok: true, message: `Proposal created (Documents → Proposal).${r.placeholder ? " Uses the PLACEHOLDER template until ESS's real one is added." : ""}` };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

const subQuoteSchema = z.object({
  subOrgId: z.uuid(),
  amount: money.refine((v) => v !== undefined, "Enter the sub's price"),
  description: z.string().max(500).optional(),
});

export async function addSubQuote(jobId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = subQuoteSchema.parse(formObject(form));
    await user.db((tx) => tx.insert(s.subCosts).values({ jobId, subOrgId: v.subOrgId, amount: v.amount!, description: v.description ?? null }));
    return { ok: true, message: "Sub quote added." };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}

/** Chooses a sub quote: the job's sub + sub cost follow it. */
export async function selectSubQuote(jobId: string, subCostId: string) {
  const user = await requireOwner();
  await user.db(async (tx) => {
    const [q] = await tx.select().from(s.subCosts).where(and(eq(s.subCosts.id, subCostId), eq(s.subCosts.jobId, jobId)));
    if (!q) return;
    await tx.update(s.subCosts).set({ selected: false }).where(eq(s.subCosts.jobId, jobId));
    await tx.update(s.subCosts).set({ selected: true }).where(eq(s.subCosts.id, subCostId));
    await tx.update(s.jobs).set({ subOrgId: q.subOrgId }).where(eq(s.jobs.id, jobId));
    await tx.insert(s.jobFinancials).values({ jobId, subCost: q.amount }).onConflictDoUpdate({ target: s.jobFinancials.jobId, set: { subCost: q.amount } });
  });
  revalidatePath(`/jobs/${jobId}`);
}

export async function makeSubCopy(jobId: string, docId: string, _prev: ActionState): Promise<ActionState> {
  await requireOwner();
  const res = await safeAction(async () => {
    const r = await createSubCopy(adminDb(), docId, { ...storageUploader(), ...storageDownloader() });
    if (r.status === "blocked") {
      return { error: `Not released — the sub copy would still contain: ${r.violations.slice(0, 5).map((v) => `“${v.slice(0, 80)}”`).join("; ")}. Edit the report and try again.` };
    }
    return { ok: true, message: `Sub copy created. Removed ${r.removed.length} item(s): ${r.removed.slice(0, 6).map((x) => x.trim().slice(0, 50)).join(" · ")}${r.removed.length > 6 ? " …" : ""}` };
  });
  revalidatePath(`/jobs/${jobId}`);
  return res;
}
