import { eq, sql } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import { FB_WEBHOOK_EVENTS, type FreshBooksClient } from "@/lib/integrations/freshbooks";

/**
 * Registers one FreshBooks callback per event for our webhook URL (idempotent: existing
 * registrations for the same event+URL are kept). FreshBooks then POSTs a verifier to each, which
 * lib/money/freshbooks-webhook.ts stores and confirms.
 */
export async function registerWebhooks(db: Db, fb: FreshBooksClient, uri: string) {
  const existing = await fb.listCallbacks();
  for (const event of FB_WEBHOOK_EVENTS) {
    const hit = existing.find((c) => c.event === event && c.uri === uri);
    if (hit) {
      // Never downgrade: our own record may already hold the verifier from the handshake.
      await mergeCallback(db, String(hit.callbackid), hit.verified ? { event, verified: true } : { event });
      continue;
    }
    // Record the id BEFORE FreshBooks sends the verifier, so the handshake can be matched.
    const created = await fb.createCallback(event, uri);
    await mergeCallback(db, String(created.callbackid), { event, verified: false });
  }
  const [conn] = await db.select({ callbacks: s.freshbooksConnection.webhookCallbacks }).from(s.freshbooksConnection);
  return conn?.callbacks ?? {};
}

type CallbackInfo = { event: string; verified: boolean; verifierEnc?: string };

/**
 * Merges one callback's fields into webhook_callbacks in a single UPDATE. FreshBooks sends the
 * verifier handshakes for all callbacks at once, so a read-modify-write of the whole map would
 * lose all but the last one (found in the local end-to-end run).
 */
export async function mergeCallback(db: Db, callbackId: string, patch: Partial<CallbackInfo>) {
  const col = s.freshbooksConnection.webhookCallbacks;
  await db
    .update(s.freshbooksConnection)
    .set({
      webhookCallbacks: sql`coalesce(${col}, '{}'::jsonb) || jsonb_build_object(${callbackId}::text, coalesce(${col} -> ${callbackId}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
    })
    .where(eq(s.freshbooksConnection.id, 1));
}
