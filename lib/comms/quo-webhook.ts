import { eq, sql } from "drizzle-orm";
import { adminDb, schema as s } from "@/lib/db";
import { quoFromEnv, type QuoEvent } from "@/lib/integrations/quo";
import { mailSenderFromEnv } from "@/lib/integrations/titan-mail";
import { processQuoEvent } from "./quo-events";
import { sendApproved, type SendDeps } from "./outbound";

/**
 * Dedupe + apply one Quo delivery (CLAUDE.md rule 7). The delivery row is locked for the whole
 * transaction, so concurrent retries of the same webhook-id can't both apply. Anything the event
 * auto-approved is sent only after commit.
 */
export async function handleQuoDelivery(deliveryId: string, event: QuoEvent, db = adminDb(), deps?: SendDeps) {
  await db
    .insert(s.webhookDeliveries)
    // Only identifiers — message content may be AIRnyc member data, and Quo re-sends the full
    // payload on every retry, so there's nothing to gain from keeping it here.
    .values({ provider: "QUO", deliveryId, eventType: event.type, payload: { eventId: event.id, resourceId: (event.data?.resource as { id?: string; callId?: string })?.id ?? (event.data?.resource as { callId?: string })?.callId ?? null } })
    .onConflictDoNothing();
  try {
    const outcome = await db.transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(s.webhookDeliveries)
        .where(sql`${s.webhookDeliveries.provider} = 'QUO' and ${s.webhookDeliveries.deliveryId} = ${deliveryId}`)
        .for("update");
      if (d.processedAt) return { duplicate: true as const };
      const out = await processQuoEvent(tx, event);
      await tx.update(s.webhookDeliveries).set({ processedAt: new Date(), error: null }).where(eq(s.webhookDeliveries.id, d.id));
      return out;
    });
    if ("toSend" in outcome && outcome.toSend?.length) {
      const send = deps ?? { quo: quoFromEnv(), mail: mailSenderFromEnv() };
      for (const id of outcome.toSend) await sendApproved(db, id, send);
    }
    return { ok: true, ...outcome };
  } catch (e) {
    console.error("[quo webhook]", event.type, e);
    await db
      .update(s.webhookDeliveries)
      .set({ error: String((e as Error).message).slice(0, 1000) })
      .where(sql`${s.webhookDeliveries.provider} = 'QUO' and ${s.webhookDeliveries.deliveryId} = ${deliveryId}`);
    return { error: (e as Error).message };
  }
}
