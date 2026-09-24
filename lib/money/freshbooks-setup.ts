import { eq } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";
import { FB_WEBHOOK_EVENTS, type FreshBooksClient } from "@/lib/integrations/freshbooks";

/**
 * Registers one FreshBooks callback per event for our webhook URL (idempotent: existing
 * registrations for the same event+URL are kept). FreshBooks then POSTs a verifier to each, which
 * lib/money/freshbooks-webhook.ts stores and confirms.
 */
export async function registerWebhooks(db: Db, fb: FreshBooksClient, uri: string) {
  const [conn] = await db.select().from(s.freshbooksConnection);
  const callbacks = { ...(conn?.webhookCallbacks ?? {}) };
  const existing = await fb.listCallbacks();
  for (const event of FB_WEBHOOK_EVENTS) {
    const hit = existing.find((c) => c.event === event && c.uri === uri);
    if (hit) {
      const id = String(hit.callbackid);
      callbacks[id] = { ...(callbacks[id] ?? {}), event, verified: Boolean(hit.verified) };
      continue;
    }
    // Record the id BEFORE FreshBooks sends the verifier, so the handshake can be matched.
    const created = await fb.createCallback(event, uri);
    callbacks[String(created.callbackid)] = { event, verified: false };
    await db.update(s.freshbooksConnection).set({ webhookCallbacks: callbacks }).where(eq(s.freshbooksConnection.id, 1));
  }
  await db.update(s.freshbooksConnection).set({ webhookCallbacks: callbacks }).where(eq(s.freshbooksConnection.id, 1));
  return callbacks;
}
