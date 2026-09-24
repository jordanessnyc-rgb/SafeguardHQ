import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { freshbooksFromEnv } from "@/lib/integrations/freshbooks";
import { handleFreshbooksWebhook } from "@/lib/money/freshbooks-webhook";

/** FreshBooks callbacks (form-encoded). Signature: X-FreshBooks-Hmac-SHA256. See lib/money/freshbooks-webhook.ts. */
export async function POST(req: Request) {
  const db = adminDb();
  const fb = freshbooksFromEnv(db);
  if (!fb) return new NextResponse("FreshBooks not configured", { status: 503 });
  const raw = await req.text();
  const result = await handleFreshbooksWebhook(db, fb, raw, req.headers.get("x-freshbooks-hmac-sha256"));
  return NextResponse.json(result.body, { status: result.status });
}
