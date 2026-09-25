/**
 * AI-assisted go/no-go (SPEC §9.6): RFP PDF → deadlines, required certs, insurance, scope,
 * submission list → a checklist against ESS's credentials. The AI only recommends; a person
 * records the decision. Fields someone already filled in are never overwritten.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db } from "@/lib/db";
import type { GoNoGo } from "@/db/schema";
import { AI_MODELS } from "@/lib/ai/config";
import { guardedParse, type AnthropicLike } from "@/lib/ai/anthropic";
import { BID_SYSTEM } from "@/lib/ai/prompts/bid";
import { fromNyInput, nyDate } from "@/lib/time";

const nyTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable();
export const BidAnalysisSchema = z.object({
  title: z.string(),
  agency: z.string().nullable(),
  solicitation_number: z.string().nullable(),
  type: z.enum(["RFP", "RFQ", "RFB", "IFB", "OTHER"]),
  questions_due: nyTime,
  due_at: nyTime,
  opening_at: nyTime,
  site_visit_at: nyTime,
  buyer_name: z.string().nullable(),
  buyer_email: z.string().nullable(),
  buyer_phone: z.string().nullable(),
  required_certs: z.array(z.string()),
  insurance_requirements: z.string().nullable(),
  scope_summary: z.string(),
  submission_requirements: z.array(z.string()),
  checklist: z.array(z.object({ item: z.string(), status: z.enum(["MET", "GAP", "UNKNOWN"]), note: z.string() })),
  recommendation: z.enum(["GO", "NO_GO", "REVIEW"]),
  summary: z.string(),
});

export async function analyzeRfp(db: Db, bidId: string, pdf: Buffer, api?: AnthropicLike, now = new Date()): Promise<{ status: "ok"; goNoGo: GoNoGo } | { status: "blocked" | "error"; reason: string }> {
  const [bid] = await db.select().from(s.bids).where(eq(s.bids.id, bidId));
  if (!bid) return { status: "error", reason: "Bid not found." };
  const creds = await db.select().from(s.credentials).where(isNull(s.credentials.archivedAt));
  const credList = creds.length
    ? creds.map((c) => `- ${c.name}${c.number ? ` #${c.number}` : ""}${c.issuer ? ` (${c.issuer})` : ""}${c.expiresAt ? `, expires ${c.expiresAt}` : ", expiry not recorded"}`).join("\n")
    : "(none recorded)";

  const res = await guardedParse(db, {
    feature: "BID_ANALYSIS",
    model: AI_MODELS.bid,
    system: BID_SYSTEM,
    userText: `TODAY: ${nyDate(now)}\n\nESS CREDENTIALS:\n${credList}\n\nAnalyze the attached solicitation.`,
    pdfs: [{ base64: pdf.toString("base64"), title: bid.title }],
    schema: BidAnalysisSchema,
    airnycLinked: false,
    maxTokens: 8000,
  }, api);
  if (res.status !== "ok") return { status: res.status, reason: res.status === "blocked" ? res.reason : res.error };

  const a = res.output;
  const at = (v: string | null) => (v ? fromNyInput(v) : null);
  const goNoGo: GoNoGo = { recommendation: a.recommendation, summary: a.summary, checklist: a.checklist, submission: a.submission_requirements, model: res.model, at: now.toISOString() };
  const keep = <T,>(cur: T | null | undefined, next: T | null) => (cur !== null && cur !== undefined && cur !== "" ? cur : next);
  await db
    .update(s.bids)
    .set({
      title: bid.title && !/^untitled/i.test(bid.title) ? bid.title : a.title,
      agency: keep(bid.agency, a.agency),
      solicitationNumber: keep(bid.solicitationNumber, a.solicitation_number),
      type: bid.type !== "OTHER" ? bid.type : a.type,
      questionsDue: keep(bid.questionsDue, at(a.questions_due)),
      dueAt: keep(bid.dueAt, at(a.due_at)),
      openingAt: keep(bid.openingAt, at(a.opening_at)),
      siteVisitAt: keep(bid.siteVisitAt, at(a.site_visit_at)),
      buyerName: keep(bid.buyerName, a.buyer_name),
      buyerEmail: keep(bid.buyerEmail, a.buyer_email),
      buyerPhone: keep(bid.buyerPhone, a.buyer_phone),
      requiredCerts: a.required_certs,
      certGaps: a.checklist.filter((c) => c.status === "GAP").map((c) => c.item),
      insuranceRequirements: keep(bid.insuranceRequirements, a.insurance_requirements),
      scope: keep(bid.scope, a.scope_summary),
      goNoGo,
      status: bid.status === "WATCHING" ? "GO_NO_GO" : bid.status,
    })
    .where(eq(s.bids.id, bidId));

  // Deadline tasks (questions + submission), once per bid.
  const existing = await db.select({ title: s.tasks.title }).from(s.tasks).where(and(eq(s.tasks.bidId, bidId), eq(s.tasks.source, "SYSTEM_RULE")));
  const mk = (title: string, due: Date | null) => (due && due > now && !existing.some((t) => t.title === title) ? [{ title, bidId, source: "SYSTEM_RULE" as const, dueAt: due }] : []);
  const [fresh] = await db.select().from(s.bids).where(eq(s.bids.id, bidId));
  const label = fresh.solicitationNumber ?? fresh.title.slice(0, 60);
  const rows = [
    ...mk(`Questions due — ${label}`, fresh.questionsDue ? new Date(fresh.questionsDue.getTime() - 2 * 86_400_000) : null),
    ...mk(`Site visit — ${label}`, fresh.siteVisitAt),
    ...mk(`Bid due — ${label}`, fresh.dueAt ? new Date(fresh.dueAt.getTime() - 3 * 86_400_000) : null),
  ];
  if (rows.length) await db.insert(s.tasks).values(rows);
  return { status: "ok", goNoGo };
}
