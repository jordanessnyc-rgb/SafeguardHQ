import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook, WebhookVerificationError, type QuoEvent } from "@/lib/integrations/quo";
import { handleQuoDelivery } from "@/lib/comms/quo-webhook";

/**
 * Quo webhook receiver (SPEC §6.1, CLAUDE.md rule 7):
 *  1. verify the Standard Webhooks signature against the raw body,
 *  2. dedupe on the `webhook-id` delivery id and apply it (lib/comms/quo-webhook.ts),
 *  3. on failure return 500 so Quo retries (~27h).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.QUO_WEBHOOK_SECRET;
  if (!secret) return new NextResponse("Webhook secret not configured", { status: 503 });

  const raw = await req.text();
  let deliveryId: string;
  try {
    deliveryId = verifyWebhook(secret, req.headers, raw);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new NextResponse(e.message, { status: 401 });
    throw e;
  }
  const event = JSON.parse(raw) as QuoEvent;
  const result = await handleQuoDelivery(deliveryId, event);
  if ("error" in result) return new NextResponse("Processing failed", { status: 500 });
  return NextResponse.json(result);
}
