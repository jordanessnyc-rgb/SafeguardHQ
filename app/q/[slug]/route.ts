import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { recordScan } from "@/lib/marketing/leads";

/** QR code target (SPEC §11): count the scan, then go to the campaign's landing page. */
export async function GET(_req: Request, ctx: RouteContext<"/q/[slug]">) {
  const { slug } = await ctx.params;
  const to = /^[a-z0-9-]{2,60}$/i.test(slug) ? await recordScan(adminDb(), slug).catch(() => null) : null;
  return NextResponse.redirect(to ?? "https://ess-nyc.com/", 302);
}
