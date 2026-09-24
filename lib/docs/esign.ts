/**
 * Proposals out for e-signature and back (SPEC §6.7): send → envelope-completed → signed PDF
 * attached and the job moved to Signed. Sending is an explicit owner action (the approval,
 * CLAUDE.md rule 6). Webhooks are only triggers: every delivery re-reads the envelope from DocuSign,
 * so duplicates and out-of-order events are harmless; the signed copy is attached exactly once.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import type { DocuSignClient } from "@/lib/integrations/docusign";
import { verifyDocuSignHmac } from "@/lib/integrations/docusign";
import type { Uploader } from "@/lib/mail/ingest";
import type { Downloader } from "@/lib/supabase/service";
import { ownerTask } from "@/lib/tasks";

type Storage = Uploader & Downloader;
export const SIGN_ANCHORS = { signHere: "\\ess_sign\\", dateSigned: "\\ess_date\\" };
const EARLY_STAGES = ["LEAD", "QUALIFIED", "PROPOSAL_SENT"];

export async function sendProposalForSignature(
  db: Db,
  documentId: string,
  deps: { ds: DocuSignClient; storage: Storage; webhookUrl?: string; signer: { email: string; name: string } },
): Promise<string> {
  const [doc] = await db.select().from(s.documents).where(eq(s.documents.id, documentId));
  if (!doc?.jobId || doc.kind !== "PROPOSAL") throw new Error("Pick a proposal document.");
  if (doc.docusignStatus && !["declined", "voided"].includes(doc.docusignStatus)) throw new Error(`This proposal is already out for signature (${doc.docusignStatus}).`);
  if (!doc.storageBucket || !doc.storagePath) throw new Error("The proposal has no file.");
  const [job] = await db.select().from(s.jobs).where(eq(s.jobs.id, doc.jobId));

  const envelopeId = await deps.ds.sendEnvelope({
    document: await deps.storage.download(doc.storageBucket, doc.storagePath),
    fileName: doc.title ?? "Proposal.docx",
    emailSubject: `Proposal ${job.jobNumber} from Environmental Safeguard Solutions — please sign`,
    signer: deps.signer,
    anchors: SIGN_ANCHORS,
    webhookUrl: deps.webhookUrl,
  });
  await db.update(s.documents).set({ docusignEnvelopeId: envelopeId, docusignStatus: "sent", status: "SENT", signedDocumentId: null }).where(eq(s.documents.id, documentId));
  if (["LEAD", "QUALIFIED"].includes(job.stage)) await db.update(s.jobs).set({ stage: "PROPOSAL_SENT" }).where(eq(s.jobs.id, job.id));
  await db.insert(s.activities).values({ type: "DOC", direction: "OUTBOUND", jobId: job.id, contactId: job.clientContactId, subject: `Proposal sent for e-signature to ${deps.signer.name} <${deps.signer.email}>`, externalId: envelopeId, occurredAt: new Date(), triageStatus: "SKIPPED" });
  return envelopeId;
}

export type EnvelopeOutcome = "signed" | "already-signed" | "declined" | "voided" | "pending" | "unknown-envelope";

/** Applies the envelope's current state from DocuSign. Safe to call any number of times. */
export async function processEnvelope(db: Db, ds: DocuSignClient, storage: Storage, envelopeId: string): Promise<EnvelopeOutcome> {
  const [doc] = await db.select().from(s.documents).where(eq(s.documents.docusignEnvelopeId, envelopeId));
  if (!doc?.jobId) return "unknown-envelope";
  const env = await ds.getEnvelope(envelopeId);
  const status = env.status.toLowerCase();

  if (status === "completed") {
    if (doc.signedDocumentId) return "already-signed";
    // Store first (deterministic path, upsert), then attach + claim in one transaction.
    const pdf = await ds.downloadSigned(envelopeId);
    const path = `jobs/${doc.jobId}/signed-${envelopeId}.pdf`;
    await storage.upload("job-files-pricing", path, pdf, "application/pdf");
    const signedId = randomUUID();
    const claimed = await db.transaction(async (tx) => {
      const [c] = await tx
        .update(s.documents)
        .set({ signedDocumentId: signedId, docusignStatus: "completed", status: "SIGNED" })
        .where(and(eq(s.documents.id, doc.id), isNull(s.documents.signedDocumentId)))
        .returning({ id: s.documents.id });
      if (!c) return false;
      await tx.insert(s.documents).values({
        id: signedId,
        jobId: doc.jobId,
        kind: "PROPOSAL",
        status: "SIGNED",
        version: doc.version,
        title: `Signed — ${(doc.title ?? "Proposal").replace(/\.docx$/i, "")}.pdf`,
        containsPricing: true,
        storageBucket: "job-files-pricing",
        storagePath: path,
        docusignEnvelopeId: null,
      });
      const [job] = await tx.select().from(s.jobs).where(eq(s.jobs.id, doc.jobId!));
      if (EARLY_STAGES.includes(job.stage)) await tx.update(s.jobs).set({ stage: "SIGNED" }).where(eq(s.jobs.id, job.id));
      await tx.insert(s.activities).values({ type: "DOC", direction: "INBOUND", jobId: job.id, contactId: job.clientContactId, subject: "Proposal signed (DocuSign) — signed copy attached", externalId: `${envelopeId}:completed`, occurredAt: env.completedDateTime ? new Date(env.completedDateTime) : new Date(), triageStatus: "SKIPPED" });
      return true;
    });
    return claimed ? "signed" : "already-signed";
  }

  if (status === "declined" || status === "voided") {
    const [changed] = await db
      .update(s.documents)
      .set({ docusignStatus: status })
      .where(and(eq(s.documents.id, doc.id), inArray(s.documents.docusignStatus, ["sent", "delivered"])))
      .returning({ id: s.documents.id });
    if (changed) {
      const [job] = await db.select({ jobNumber: s.jobs.jobNumber }).from(s.jobs).where(eq(s.jobs.id, doc.jobId));
      await ownerTask(db, { title: `Proposal ${status} in DocuSign — ${job.jobNumber}`, description: env.voidedReason ?? "Follow up with the client.", jobId: doc.jobId });
    }
    return status;
  }
  if (["sent", "delivered"].includes(status)) await db.update(s.documents).set({ docusignStatus: status }).where(and(eq(s.documents.id, doc.id), isNull(s.documents.signedDocumentId)));
  return "pending";
}

/**
 * Connect webhook: HMAC-verified, deduplicated on a hash of the raw body (DocuSign sends no
 * delivery ID), recorded, then processed. Returns the HTTP status and, when accepted, the
 * delivery to process (the route acknowledges within DocuSign's 5-second window and processes after).
 */
export async function acceptDocuSignWebhook(db: Db, raw: string, headers: Headers, hmacKeys: string[]): Promise<{ status: number; deliveryId?: string; envelopeId?: string }> {
  if (!verifyDocuSignHmac(raw, headers, hmacKeys)) return { status: 401 };
  let body: { event?: string; data?: { envelopeId?: string } };
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400 };
  }
  const envelopeId = body.data?.envelopeId;
  if (!envelopeId) return { status: 200 };
  const [row] = await db
    .insert(s.webhookDeliveries)
    .values({ provider: "DOCUSIGN", deliveryId: createHash("sha256").update(raw).digest("hex"), eventType: body.event ?? null, payload: { event: body.event, envelopeId } })
    .onConflictDoNothing()
    .returning({ id: s.webhookDeliveries.id });
  return row ? { status: 200, deliveryId: row.id, envelopeId } : { status: 200 };
}

export async function runDocuSignDelivery(db: Db, ds: DocuSignClient, storage: Storage, deliveryId: string, envelopeId: string) {
  try {
    await processEnvelope(db, ds, storage, envelopeId);
    await db.update(s.webhookDeliveries).set({ processedAt: new Date(), error: null }).where(eq(s.webhookDeliveries.id, deliveryId));
  } catch (e) {
    await db.update(s.webhookDeliveries).set({ error: (e as Error).message.slice(0, 1000) }).where(eq(s.webhookDeliveries.id, deliveryId));
  }
}

/** Worker fallback: deliveries acknowledged but not processed (crash, DocuSign API down) are retried for 3 days. */
export async function retryDocuSignDeliveries(db: Db, ds: DocuSignClient, storage: Storage, now = new Date()) {
  const stuck = await db
    .select()
    .from(s.webhookDeliveries)
    .where(and(eq(s.webhookDeliveries.provider, "DOCUSIGN"), isNull(s.webhookDeliveries.processedAt), lt(s.webhookDeliveries.receivedAt, new Date(now.getTime() - 2 * 60_000)), gt(s.webhookDeliveries.receivedAt, new Date(now.getTime() - 3 * 86_400_000))))
    .limit(20);
  for (const d of stuck) {
    const envelopeId = (d.payload as { envelopeId?: string } | null)?.envelopeId;
    if (envelopeId) await runDocuSignDelivery(db, ds, storage, d.id, envelopeId);
  }
  return stuck.length;
}
