/**
 * AI reply drafts (SPEC §9.2). Always lands in the Outbox as a DRAFT — nothing is sent without a
 * human approving it (CLAUDE.md rule 6). Prices reach the model only when the OWNER asks for them,
 * and any draft that mentions money is marked contains_pricing so RLS hides it from VAs: pricing
 * can only ever go out with the owner as the approver.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { getCase } from "@/lib/airnyc/cases";
import { revealActivity } from "@/lib/comms/sensitive";
import { createDraft } from "@/lib/comms/outbound";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import { AI_MODELS } from "./config";
import { guardedParse, type AnthropicLike } from "./anthropic";
import { REPLY_SYSTEM } from "./prompts/reply";

type Conn = Db | Tx;

export const ReplySchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  missing_info: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

/** Money talk in a draft → owner-only. Deliberately broad: a false positive only hides it from VAs. */
export const PRICING_RE = /\$\s?\d|\b\d[\d,]*(?:\.\d\d)?\s?(?:dollars|usd)\b|\b(?:price|pricing|priced|cost|costs|fee|fees|quote|quoted|invoice|invoiced|deposit|payment|rate|rates)\b/i;

/** AI drafts mark facts they don't have as [inspection date] etc.; these must be filled before sending. */
export const AI_PLACEHOLDER_RE = /\[[A-Za-z][A-Za-z0-9 ,.'/-]{1,60}\]/;

export type DraftReplyResult = { status: "drafted"; outboundId: string; containsPricing: boolean; missingInfo: string[] } | { status: "blocked" | "error" | "skipped"; reason: string };

export async function draftReply(
  conn: Conn,
  activityId: string,
  opts: { includePricing: boolean; requesterRole: "OWNER" | "VA"; actorId?: string | null },
  api?: AnthropicLike,
): Promise<DraftReplyResult> {
  const [a] = await conn.select().from(s.activities).where(eq(s.activities.id, activityId));
  if (!a) return { status: "skipped", reason: "Message not found." };
  if (a.direction !== "INBOUND" || !["SMS", "EMAIL_IN"].includes(a.type)) return { status: "skipped", reason: "Only inbound texts and emails can be answered." };
  if (!a.fromAddress) return { status: "skipped", reason: "No sender address to reply to." };
  const includePricing = opts.includePricing && opts.requesterRole === "OWNER";

  const [cfg] = await conn.select().from(s.settings);
  const airnycLinked = a.sensitive || a.airnycCaseId != null;
  const mayRead = !airnycLinked || Boolean(cfg?.airnycAiAllowed); // don't decrypt what the wrapper will block
  const read = async (x: typeof a) => (!mayRead ? { subject: null, body: null } : x.sensitive ? await revealActivity(conn, opts.actorId ?? null, x, "ai-reply-draft") : { subject: x.subject, body: x.body });

  const [contact] = a.contactId ? await conn.select().from(s.contacts).where(eq(s.contacts.id, a.contactId)) : [];
  const jobId =
    a.jobId ??
    (a.contactId
      ? (
          await conn
            .select({ id: s.jobs.id })
            .from(s.jobs)
            .where(and(eq(s.jobs.clientContactId, a.contactId), isNull(s.jobs.archivedAt)))
            .orderBy(desc(s.jobs.updatedAt))
            .limit(1)
        )[0]?.id
      : undefined) ??
    null;
  const [jobRow] = jobId
    ? await conn
        .select({ job: s.jobs, stage: s.pipelineStages.name, address: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough })
        .from(s.jobs)
        .leftJoin(s.pipelineStages, and(eq(s.pipelineStages.pipelineKey, s.jobs.pipelineKey), eq(s.pipelineStages.key, s.jobs.stage)))
        .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
        .where(eq(s.jobs.id, jobId))
    : [];
  const [fin] = includePricing && jobId ? await conn.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, jobId)) : [];
  const kase = mayRead && a.airnycCaseId ? await getCase(conn, null, a.airnycCaseId) : null;
  const knownNames = [kase?.memberName, kase?.guardianName, contact?.firstName, contact?.lastName].filter((n): n is string => Boolean(n?.trim()));
  // Redaction only removes names it knows; with none known, AIRnyc text is not sent at all.
  if (airnycLinked && mayRead && knownNames.length === 0) {
    await conn.insert(s.aiCalls).values({ feature: "REPLY_DRAFT", model: AI_MODELS.draft, activityId: a.id, airnycLinked: true, blocked: "no_known_names_to_redact" });
    return { status: "blocked", reason: "AIRnyc message without a linked case or named contact — names can't be redacted, so it wasn't sent to AI." };
  }

  // The thread: this contact's recent texts/emails/calls, oldest first, ending with the message being answered.
  const history = a.contactId
    ? await conn
        .select()
        .from(s.activities)
        .where(and(eq(s.activities.contactId, a.contactId), inArray(s.activities.type, ["SMS", "EMAIL_IN", "EMAIL_OUT", "CALL"])))
        .orderBy(desc(s.activities.occurredAt))
        .limit(12)
    : [a];
  const thread: string[] = [];
  for (const h of history.filter((x) => x.occurredAt <= a.occurredAt).reverse()) {
    const c = await read(h);
    const who = h.direction === "INBOUND" ? (contact ? personName(contact) : "Client") : "ESS";
    const kind = h.type === "CALL" ? "call" : h.type === "SMS" ? "text" : "email";
    const text = h.type === "CALL" ? (h.summary ?? `(${h.callStatus ?? "call"})`) : (c.body ?? "");
    thread.push(`--- ${kind} from ${who}, ${h.occurredAt.toISOString().slice(0, 16).replace("T", " ")} UTC${h.id === a.id ? " [REPLY TO THIS]" : ""}${c.subject ? `\nSubject: ${c.subject}` : ""}\n${text.slice(0, 4000)}`);
  }
  const current = await read(a);

  const job = jobRow?.job;
  const context = [
    `Channel: ${a.type === "SMS" ? "text message" : "email"}`,
    `Brand: ${job?.brand === "GAS_PRO" ? "Gas Pro Inspectors" : "ESS"}`,
    contact && `Client: ${personName(contact)}`,
    job &&
      [
        `JOB ${job.jobNumber}: ${label(SERVICE_LABELS, job.serviceCode)}, stage ${jobRow.stage ?? job.stage}`,
        jobRow.address && `Property: ${jobRow.address}${jobRow.unit ? `, Apt ${jobRow.unit}` : ""}${jobRow.borough ? `, ${jobRow.borough}` : ""}`,
        job.scheduledAt && `Scheduled: ${job.scheduledAt.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" })}`,
        job.deliveredAt && `Report delivered: ${job.deliveredAt.toISOString().slice(0, 10)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    fin &&
      [
        "PRICING (owner approved for this draft):",
        fin.quotedAmount && `Quoted total: $${fin.quotedAmount}`,
        ...fin.lineItems.map((l) => `- ${l.description}: ${l.quantity} × $${l.unitPrice}`),
        fin.invoiceStatus && `Invoice status: ${fin.invoiceStatus}`,
      ]
        .filter(Boolean)
        .join("\n"),
    cfg?.aiVoiceNotes && `JORDAN'S STYLE NOTES:\n${cfg.aiVoiceNotes}`,
    "",
    "CONVERSATION:",
    ...thread,
  ]
    .filter((x): x is string => typeof x === "string")
    .join("\n");

  const res = await guardedParse(
    conn,
    {
      feature: "REPLY_DRAFT",
      model: AI_MODELS.draft,
      system: REPLY_SYSTEM,
      userText: context,
      schema: ReplySchema,
      airnycLinked,
      knownNames,
      jobId,
      activityId: a.id,
      maxTokens: 4000,
    },
    api,
  );
  if (res.status !== "ok") return { status: res.status, reason: res.status === "blocked" ? res.reason : res.error };

  const d = res.output;
  const containsPricing = includePricing || PRICING_RE.test(`${d.subject ?? ""}\n${d.body}`);
  let fromLineId: string | null = null;
  if (a.type === "SMS") {
    const [line] = await conn
      .select({ id: s.phoneLines.id })
      .from(s.phoneLines)
      .where(a.channelLine ? eq(s.phoneLines.lineKey, a.channelLine) : eq(s.phoneLines.brand, job?.brand ?? "ESS"))
      .limit(1);
    fromLineId = line?.id ?? null;
    if (!fromLineId) return { status: "error", reason: "No Quo line to reply from (Settings → Communications)." };
  }
  const draft = await createDraft(conn, {
    channel: a.type === "SMS" ? "SMS" : "EMAIL",
    source: "AI_DRAFT",
    toAddress: a.fromAddress,
    fromLineId,
    fromEmail: a.type === "SMS" ? null : (cfg?.defaultFromEmail ?? null),
    subject: a.type === "SMS" ? null : (d.subject ?? (current.subject ? `Re: ${current.subject}` : null)),
    body: d.body,
    inReplyTo: a.type === "EMAIL_IN" ? a.externalId : null,
    brand: job?.brand ?? "ESS",
    contactId: a.contactId,
    jobId,
    airnycCaseId: a.airnycCaseId,
    replyToActivityId: a.id,
    containsPricing,
  });
  return { status: "drafted", outboundId: draft.id, containsPricing, missingInfo: d.missing_info };
}
