/**
 * AI call extraction (SPEC §9.3): from a Quo transcript, pull the caller's details, the property,
 * the service and ESS's promised follow-ups. Follow-ups become tasks; the caller's name and email
 * only fill blanks on the contact (never overwrite what staff entered). The address and service are
 * stored on the call for staff to turn into a property/job — the AI never creates jobs itself.
 */
import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db } from "@/lib/db";
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

  const transcript = a.transcript ?? "";
  const [contact] = a.contactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, a.contactId)) : [];

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
  await db.update(s.activities).set({ aiClassification: { extraction: x } }).where(eq(s.activities.id, a.id));

  if (contact) {
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
    title: `${f.title.slice(0, 160)} — ${who}`,
    description: [x.address && `Address: ${x.address}`, x.service_code && `Service: ${x.service_code}`, `Call summary: ${x.summary}`].filter(Boolean).join("\n"),
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
    .where(and(eq(s.activities.type, "CALL"), isNull(s.activities.aiExtractedAt), gt(s.activities.occurredAt, new Date(now.getTime() - 3 * 86_400_000)), isNotNull(s.activities.transcript)))
    .orderBy(asc(s.activities.occurredAt))
    .limit(limit);
  let n = 0;
  for (const a of pending) if ((await extractCall(db, a, api)) === "extracted") n++;
  return n;
}
