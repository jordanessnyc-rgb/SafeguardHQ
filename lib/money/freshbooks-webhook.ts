/**
 * FreshBooks webhook handling (SPEC §6.2, CLAUDE.md rule 7).
 * FreshBooks callbacks have NO delivery id and no ordering guarantee, and two different updates to
 * the same invoice can produce byte-identical bodies. So instead of deduping on the body (which
 * would drop real updates), every delivery is a "re-fetch object_id and apply current state"
 * trigger — idempotent by construction. Deliveries are still logged to webhook_deliveries.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto";
import { verifyFreshbooksSignature, type FreshBooksClient } from "@/lib/integrations/freshbooks";
import { syncInvoice, syncPayment } from "./invoicing";
import { refreshImportedClient } from "./client-sync";

export type FbWebhookResult = { status: 200 | 401 | 500; body: Record<string, unknown> };

export async function handleFreshbooksWebhook(db: Db, fb: FreshBooksClient, rawBody: string, signature: string | null): Promise<FbWebhookResult> {
  const pairs = [...new URLSearchParams(rawBody).entries()] as [string, string][];
  const form = Object.fromEntries(pairs);
  const [conn] = await db.select().from(s.freshbooksConnection);
  const callbacks = conn?.webhookCallbacks ?? {};

  // --- Verification handshake: FreshBooks POSTs a verifier for a callback we just registered. ---
  if (form.verifier) {
    const callbackId = form.object_id ?? form.callbackid ?? form.callback_id;
    if (!callbackId || !callbacks[callbackId]) return { status: 401, body: { error: "unknown callback" } };
    const updated = { ...callbacks, [callbackId]: { ...callbacks[callbackId], verifierEnc: encryptField(form.verifier)! } };
    await db.update(s.freshbooksConnection).set({ webhookCallbacks: updated }).where(eq(s.freshbooksConnection.id, 1));
    await fb.verifyCallback(callbackId, form.verifier);
    updated[callbackId] = { ...updated[callbackId], verified: true };
    await db.update(s.freshbooksConnection).set({ webhookCallbacks: updated }).where(eq(s.freshbooksConnection.id, 1));
    return { status: 200, body: { verified: callbackId } };
  }

  // --- Normal delivery: must be signed with one of our callbacks' verifiers. ---
  const verifiers = Object.values(callbacks)
    .map((c) => (c.verifierEnc ? decryptField(c.verifierEnc) : null))
    .filter((v): v is string => Boolean(v));
  if (!verifyFreshbooksSignature(signature, pairs, verifiers)) return { status: 401, body: { error: "bad signature" } };
  if (conn && form.account_id && form.account_id !== conn.accountId) return { status: 200, body: { ignored: "other account" } };

  const name = form.name ?? "";
  const objectId = form.object_id ?? "";
  const [delivery] = await db
    .insert(s.webhookDeliveries)
    .values({ provider: "FRESHBOOKS", deliveryId: randomUUID(), eventType: name, payload: { name, object_id: objectId } })
    .returning();
  try {
    let jobId: string | null = null;
    if (name.startsWith("invoice.")) jobId = await syncInvoice(db, fb, objectId).catch(async (e) => {
      if (name === "invoice.delete") {
        await db.update(s.invoicesCache).set({ status: "deleted", outstanding: "0" }).where(eq(s.invoicesCache.freshbooksInvoiceId, objectId));
        return null;
      }
      throw e;
    });
    else if (name.startsWith("payment.")) jobId = await syncPayment(db, fb, objectId);
    else if (name.startsWith("client.")) await refreshImportedClient(db, fb, objectId);
    await db.update(s.webhookDeliveries).set({ processedAt: new Date() }).where(eq(s.webhookDeliveries.id, delivery.id));
    return { status: 200, body: { ok: true, name, jobId } };
  } catch (e) {
    await db.update(s.webhookDeliveries).set({ error: (e as Error).message.slice(0, 1000) }).where(eq(s.webhookDeliveries.id, delivery.id));
    // Non-2xx → FreshBooks retries later; our re-fetch makes that retry safe.
    return { status: 500, body: { error: "processing failed" } };
  }
}
