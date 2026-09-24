import { after, NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { docusignConfigFromEnv, DocuSignClient } from "@/lib/integrations/docusign";
import { acceptDocuSignWebhook, runDocuSignDelivery } from "@/lib/docs/esign";
import { storageDownloader, storageUploader } from "@/lib/supabase/service";

/**
 * DocuSign Connect (envelope-level eventNotification). Acknowledge fast (DocuSign wants a 200
 * within 5 seconds), process after the response; the worker retries anything left unprocessed.
 */
export async function POST(req: Request) {
  const cfg = docusignConfigFromEnv();
  if (!cfg) return new NextResponse("DocuSign not configured", { status: 503 });
  const raw = await req.text();
  const db = adminDb();
  const r = await acceptDocuSignWebhook(db, raw, req.headers, cfg.hmacKeys);
  if (r.deliveryId && r.envelopeId) {
    const { deliveryId, envelopeId } = r;
    after(() => runDocuSignDelivery(db, new DocuSignClient(cfg), { ...storageUploader(), ...storageDownloader() }, deliveryId, envelopeId));
  }
  return new NextResponse(null, { status: r.status });
}
