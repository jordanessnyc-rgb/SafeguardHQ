/**
 * AI triage of inbound email/SMS (SPEC §9.1). Strict JSON via structured outputs; confidence below
 * settings.triage_confidence_threshold → NEEDS_REVIEW (the review queue). AIRnyc-linked messages
 * go through the guarded wrapper, which blocks them unless AIRnyc AI is allowed.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { getCase } from "@/lib/airnyc/cases";
import { revealActivity } from "@/lib/comms/sensitive";
import { JOB_NUMBER_RE } from "@/lib/mail/patterns";
import { AI_MODELS } from "./config";
import { guardedParse, type AnthropicLike } from "./anthropic";
import { TRIAGE_SYSTEM } from "./prompts/triage";

type Conn = Db | Tx;

export const TRIAGE_CATEGORIES = ["NEW_LEAD", "EXISTING_JOB", "LAB_RESULT", "INVOICE_QUESTION", "BID_NOTICE", "AIRNYC", "VENDOR", "SPAM", "OTHER"] as const;

export const TriageSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  confidence: z.number().min(0).max(1),
  job_match_hints: z.array(z.string()),
  address: z.string().nullable(),
  service_code: z.enum(s.serviceCodeEnum.enumValues).nullable(),
  urgency: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  summary: z.string(),
});
export type Triage = z.infer<typeof TriageSchema>;

type Activity = typeof s.activities.$inferSelect;

export async function triageActivity(conn: Conn, a: Activity, api?: AnthropicLike): Promise<Activity["triageStatus"]> {
  const airnycLinked = a.sensitive || a.airnycCaseId != null;
  const [cfg] = await conn.select().from(s.settings);
  // Don't even decrypt AIRnyc content when AI is off for it — guardedParse will block and log.
  const mayRead = !airnycLinked || Boolean(cfg?.airnycAiAllowed);
  const content = !mayRead ? {} : a.sensitive ? await revealActivity(conn, null, a, "ai-triage") : { subject: a.subject, body: a.body };
  const kase = mayRead && a.airnycCaseId ? await getCase(conn, null, a.airnycCaseId) : null;
  const userText = [
    `Channel: ${a.type === "SMS" ? "text message" : "email"}`,
    a.fromAddress && `From: ${a.fromAddress}`,
    content.subject && `Subject: ${content.subject}`,
    "",
    (content.body ?? "").slice(0, 12_000),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n");

  const res = await guardedParse(
    conn,
    {
      feature: "TRIAGE",
      model: AI_MODELS.classify,
      system: TRIAGE_SYSTEM,
      userText,
      schema: TriageSchema,
      airnycLinked,
      knownNames: [kase?.memberName, kase?.guardianName],
      jobId: a.jobId,
      activityId: a.id,
      maxTokens: 1024,
    },
    api,
  );

  if (res.status === "blocked") {
    await conn.update(s.activities).set({ triageStatus: "BLOCKED", triageCategory: airnycLinked ? "AIRNYC" : null, aiClassification: { blocked: res.reason } }).where(eq(s.activities.id, a.id));
    return "BLOCKED";
  }
  if (res.status === "error") {
    await conn.update(s.activities).set({ triageStatus: "NEEDS_REVIEW", aiClassification: { error: res.error } }).where(eq(s.activities.id, a.id));
    return "NEEDS_REVIEW";
  }

  const threshold = Number(cfg?.triageConfidenceThreshold ?? 0.75);
  const t = res.output;
  const status = t.confidence >= threshold && t.category !== "OTHER" ? "AUTO" : "NEEDS_REVIEW";

  // Confident EXISTING_JOB with a job number hint → file it under that job.
  let jobId = a.jobId;
  if (!jobId && t.category === "EXISTING_JOB") {
    const numbers = [...new Set(t.job_match_hints.join(" ").match(JOB_NUMBER_RE) ?? [])].map((n) => n.toUpperCase());
    if (numbers.length) {
      const [j] = await conn.select({ id: s.jobs.id }).from(s.jobs).where(inArray(s.jobs.jobNumber, numbers)).limit(1);
      jobId = j?.id ?? null;
    }
  }
  await conn
    .update(s.activities)
    .set({ triageStatus: status, triageCategory: t.category, aiClassification: t, summary: a.sensitive ? null : t.summary, jobId })
    .where(eq(s.activities.id, a.id));

  if (status === "AUTO" && t.category === "NEW_LEAD") {
    await conn.insert(s.tasks).values({
      title: `New lead (${a.type === "SMS" ? "text" : "email"}) — ${t.summary.slice(0, 200)}`,
      description: [t.address && `Address: ${t.address}`, t.service_code && `Service: ${t.service_code}`, `Urgency: ${t.urgency}`].filter(Boolean).join("\n"),
      source: "EMAIL_AI",
      contactId: a.contactId,
      dueAt: new Date(Date.now() + (t.urgency === "URGENT" ? 2 : 24) * 3600_000),
    });
  }
  return status;
}

/** Worker entry: triage a batch of PENDING inbound messages. */
export async function triagePending(db: Db, limit = 20, api?: AnthropicLike): Promise<number> {
  const pending = await db
    .select()
    .from(s.activities)
    .where(and(eq(s.activities.triageStatus, "PENDING"), inArray(s.activities.type, ["EMAIL_IN", "SMS"]), eq(s.activities.direction, "INBOUND")))
    .orderBy(asc(s.activities.occurredAt))
    .limit(limit);
  for (const a of pending) await db.transaction((tx) => triageActivity(tx, a, api));
  return pending.length;
}
