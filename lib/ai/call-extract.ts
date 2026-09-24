/**
 * AI call extraction (SPEC §9.3): from a Quo transcript, pull the caller's details, the property,
 * the service and ESS's promised follow-ups. Follow-ups become tasks; the caller's name and email
 * only fill blanks on the contact (never overwrite what staff entered). The address and service are
 * stored on the call for staff to turn into a property/job — the AI never creates jobs itself.
 */
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db } from "@/lib/db";
import { getCase } from "@/lib/airnyc/cases";
import { revealActivity } from "@/lib/comms/sensitive";
import { AI_MODELS } from "./config";
import { guardedParse, type AnthropicLike } from "./anthropic";
import { CALL_EXTRACT_SYSTEM } from "./prompts/call-extract";

export const CallExtractSchema = z.object({
  caller_first_name: z.string().nullable(),
  caller_last_name: z.string().nullable(),
  caller_email: z.string().nullable(),
  address: z.string().nullable(),
  service_code: z.enum(s.serviceCodeEnum.enumValues).nullable(),
  urgency: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  follow_ups: z.array(z.object({ title: z.string(), due_in_days: z.number().int().min(0).max(90).nullable() })),
  summary: z.string(),
});
export type CallExtract = z.infer<typeof CallExtractSchema>;

type Activity = typeof s.activities.$inferSelect;

export async function extractCall(db: Db, a: Activity, api?: AnthropicLike, now = new Date()): Promise<"extracted" | "blocked" | "error" | "skipped"> {
  // Claim once: a retry or a second worker never double-creates follow-up tasks.
  const [claimed] = await db.update(s.activities).set({ aiExtractedAt: now }).where(and(eq(s.activities.id, a.id), isNull(s.activities.aiExtractedAt))).returning({ id: s.activities.id });
  if (!claimed) return "skipped";

  const [cfg] = await db.select().from(s.settings);
  const airnycLinked = a.sensitive || a.airnycCaseId != null;
  const mayRead = !airnycLinked || Boolean(cfg?.airnycAiAllowed);
  const transcript = !mayRead ? "" : a.sensitive ? ((await revealActivity(db, null, a, "ai-call-extract")).transcript ?? "") : (a.transcript ?? "");
  const kase = mayRead && a.airnycCaseId ? await getCase(db, null, a.airnycCaseId) : null;
  const [contact] = a.contactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, a.contactId)) : [];
  const knownNames = [kase?.memberName, kase?.guardianName, contact?.firstName, contact?.lastName].filter((n): n is string => Boolean(n?.trim()));
  // Redaction can only remove names it knows. An AIRnyc call with no linked case or named contact
  // could carry a member's name straight to the model, so it is not sent at all.
  if (airnycLinked && mayRead && knownNames.length === 0) {
    const reason = "AIRnyc call without a linked case or named contact — names can't be redacted, so it wasn't sent to AI.";
    await db.insert(s.aiCalls).values({ feature: "CALL_EXTRACT", model: AI_MODELS.classify, activityId: a.id, airnycLinked: true, blocked: "no_known_names_to_redact" });
    await db.update(s.activities).set({ aiClassification: { extractionBlocked: reason } }).where(eq(s.activities.id, a.id));
    return "blocked";
  }

  const res = await guardedParse(
    db,
    {
      feature: "CALL_EXTRACT",
      model: AI_MODELS.classify,
      system: CALL_EXTRACT_SYSTEM,
      userText: [
        a.nextSteps?.length ? `ALREADY CAPTURED (Quo next steps):\n${a.nextSteps.map((n) => `- ${n}`).join("\n")}\n` : "",
        `TRANSCRIPT (${a.direction === "INBOUND" ? "inbound" : "outbound"} call):`,
        transcript.slice(0, 40_000),
      ].join("\n"),
      schema: CallExtractSchema,
      airnycLinked,
      knownNames,
      jobId: a.jobId,
      activityId: a.id,
      maxTokens: 2000,
    },
    api,
  );
  if (res.status === "blocked") {
    await db.update(s.activities).set({ aiClassification: { extractionBlocked: res.reason } }).where(eq(s.activities.id, a.id));
    return "blocked";
  }
  if (res.status === "error") {
    await db.update(s.activities).set({ aiClassification: { extractionError: res.error } }).where(eq(s.activities.id, a.id));
    return "error";
  }
  const x = res.output;
  // AIRnyc calls: keep the extraction off the plaintext row (it may carry member details).
  await db.update(s.activities).set({ aiClassification: a.sensitive ? { extraction: { urgency: x.urgency, follow_ups: x.follow_ups.length } } : { extraction: x } }).where(eq(s.activities.id, a.id));

  if (contact && !a.sensitive) {
    const fill: Partial<typeof s.contacts.$inferInsert> = {};
    if (!contact.firstName && !contact.lastName && (x.caller_first_name || x.caller_last_name)) {
      fill.firstName = x.caller_first_name;
      fill.lastName = x.caller_last_name;
    }
    const email = x.caller_email?.trim().toLowerCase();
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && contact.emails.length === 0) fill.emails = [email];
    if (Object.keys(fill).length) await db.update(s.contacts).set(fill).where(eq(s.contacts.id, contact.id));
  }

  const known = contact && (contact.firstName || contact.lastName) ? [contact.firstName, contact.lastName] : [x.caller_first_name, x.caller_last_name];
  const who = known.filter(Boolean).join(" ") || "caller";
  const tasks = x.follow_ups.map((f) => ({
    title: a.sensitive ? `${f.title.slice(0, 120)} (AIRnyc call)` : `${f.title.slice(0, 160)} — ${who}`,
    description: a.sensitive ? "From an AIRnyc call — open the call on the timeline for details." : [x.address && `Address: ${x.address}`, x.service_code && `Service: ${x.service_code}`, `Call summary: ${x.summary}`].filter(Boolean).join("\n"),
    source: "CALL_AI" as const,
    contactId: a.contactId,
    jobId: a.jobId,
    airnycCaseId: a.airnycCaseId,
    dueAt: new Date(now.getTime() + (f.due_in_days ?? (x.urgency === "URGENT" ? 0 : 1)) * 86_400_000 + (x.urgency === "URGENT" ? 2 * 3600_000 : 0)),
  }));
  if (tasks.length) await db.insert(s.tasks).values(tasks);
  return "extracted";
}

/**
 * Worker entry: recent calls with a transcript that haven't been extracted yet. Calls older than
 * 3 days are left alone so turning the feature on doesn't create follow-ups for stale conversations.
 */
export async function extractPendingCalls(db: Db, limit = 10, api?: AnthropicLike, now = new Date()): Promise<number> {
  const pending = await db
    .select()
    .from(s.activities)
    .where(and(eq(s.activities.type, "CALL"), isNull(s.activities.aiExtractedAt), gt(s.activities.occurredAt, new Date(now.getTime() - 3 * 86_400_000)), or(isNotNull(s.activities.transcript), sql`${s.activities.aiClassification} ->> 'sealedTranscript' = 'true'`)))
    .orderBy(asc(s.activities.occurredAt))
    .limit(limit);
  let n = 0;
  for (const a of pending) if ((await extractCall(db, a, api)) === "extracted") n++;
  return n;
}
