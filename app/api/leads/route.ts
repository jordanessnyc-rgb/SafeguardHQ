import { timingSafeEqual } from "node:crypto";
import { and, count, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { adminDb, schema as s } from "@/lib/db";
import { acceptWebLead, WebLeadSchema } from "@/lib/marketing/leads";

/**
 * Public lead intake for the ess-nyc.com form (SPEC §11). Accepts JSON (fetch) or a plain HTML form
 * post. Browsers must come from an allowed origin; server-to-server posts (form builders) send
 * X-Lead-Key. Honeypot field + a global rate limit keep bots out. Nothing is sent to the lead
 * automatically unless auto_send_sms is on (the acknowledgment is an Outbox draft).
 */
const allowedOrigins = () => (process.env.LEADS_ALLOWED_ORIGINS ?? "https://ess-nyc.com,https://www.ess-nyc.com").split(",").map((o) => o.trim()).filter(Boolean);
const MAX_PER_10_MIN = 30;

function cors(origin: string | null): Record<string, string> {
  return origin && allowedOrigins().includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : {};
}

function keyOk(req: Request) {
  const key = process.env.LEADS_API_KEY;
  const got = req.headers.get("x-lead-key");
  return Boolean(key && got && key.length === got.length && timingSafeEqual(Buffer.from(key), Buffer.from(got)));
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (origin ? !allowedOrigins().includes(origin) : !keyOk(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) return NextResponse.json({ error: "too large" }, { status: 413, headers });

  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const raw = isForm ? Object.fromEntries(new URLSearchParams(await req.text())) : await req.json().catch(() => ({}));
  const parsed = WebLeadSchema.safeParse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" && k !== "website" ? undefined : v])));
  if (!parsed.success) return NextResponse.json({ error: "invalid", issues: parsed.error.issues.map((i) => i.message) }, { status: 400, headers });

  const db = adminDb();
  const [{ n }] = await db
    .select({ n: count() })
    .from(s.activities)
    .where(and(eq(s.activities.subject, "Web form lead"), gt(s.activities.occurredAt, new Date(Date.now() - 10 * 60_000))));
  if (n >= MAX_PER_10_MIN) return NextResponse.json({ error: "busy, try again shortly" }, { status: 429, headers });

  const out = await acceptWebLead(db, parsed.data);
  // Plain HTML form: go back to the site's thank-you page (only to an allowed origin).
  const back = typeof raw.redirect === "string" ? raw.redirect : null;
  if (isForm && back && allowedOrigins().some((o) => back.startsWith(`${o}/`))) return NextResponse.redirect(back, 303);
  return NextResponse.json({ ok: true, status: out.status === "spam" ? "created" : out.status }, { status: 200, headers });
}
