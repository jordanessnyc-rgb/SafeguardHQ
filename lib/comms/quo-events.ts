/**
 * Applies one verified Quo webhook event to the CRM (SPEC §6.1). Must be idempotent and
 * order-independent: Quo retries for ~27h and doesn't guarantee ordering, so every event upserts
 * by the Quo call/message id and only fills fields it owns (a late call.completed never wipes a
 * summary that arrived first).
 */
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import type {
  QuoCallResource,
  QuoContactResource,
  QuoContext,
  QuoEvent,
  QuoMessageResource,
  QuoSummaryResource,
  QuoTranscriptResource,
} from "@/lib/integrations/quo";
import { toE164 } from "@/lib/phone";
import { isWithinBusinessHours } from "@/lib/time";
import { findContactByPhone, findOrCreateLeadByPhone } from "./contacts";
import { approve, createDraft } from "./outbound";
import { mergeSealed, sealContent } from "./sensitive";
import { BRAND_INFO, renderTemplate } from "./templates";

type Conn = Db | Tx;
type Line = typeof s.phoneLines.$inferSelect;

export type QuoOutcome = {
  handled: boolean;
  activityId?: string;
  note?: string;
  /** Approved outbound messages to send AFTER the transaction commits (never send inside it). */
  toSend?: string[];
};

const MISSED_STATUSES = new Set(["unanswered", "missed", "abandoned", "no-answer"]);
const AIRNYC_LINE = "AIRNYC";

async function lineFor(conn: Conn, ctx?: QuoContext): Promise<Line | null> {
  if (!ctx?.phoneNumberId) return null;
  const [line] = await conn.select().from(s.phoneLines).where(eq(s.phoneLines.quoPhoneNumberId, ctx.phoneNumberId));
  return line ?? null;
}

/** The outside party's number for a message or call. */
function counterpart(event: QuoEvent, direction?: string): string | null {
  const ctx = event.data.context ?? {};
  if (ctx.participants?.external?.length) return toE164(ctx.participants.external[0]);
  if (direction === "incoming") return toE164(ctx.senderIdentifier);
  return toE164(ctx.recipientIdentifiers?.[0]);
}

const ts = (v?: string | null) => (v ? new Date(v) : undefined);

/** If the contact has exactly one open job, file the call/text under it too. */
async function soleOpenJob(conn: Conn, contactId: string | undefined): Promise<string | undefined> {
  if (!contactId) return undefined;
  const rows = await conn
    .select({ id: s.jobs.id })
    .from(s.jobs)
    .where(
      and(
        eq(s.jobs.clientContactId, contactId),
        isNull(s.jobs.archivedAt),
        sql`${s.jobs.stage} not in ('CLOSED','LOST','NEXT_CYCLE_SCHEDULED','PAID')`,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0].id : undefined;
}

export async function processQuoEvent(conn: Conn, event: QuoEvent): Promise<QuoOutcome> {
  switch (event.type) {
    case "message.received":
    case "message.delivered":
    case "message.undelivered":
    case "message.failed":
      return onMessage(conn, event);
    case "call.completed":
    case "call.missed":
      return onCall(conn, event);
    case "call.summary.completed":
    case "call.transcript.completed": {
      // Feature-flagged: summaries/transcripts need a Quo Business/Scale plan (SPEC §6.1).
      const [cfg] = await conn.select({ on: s.settings.quoSummariesEnabled }).from(s.settings);
      if (!cfg?.on) return { handled: false, note: "quo summaries disabled in settings" };
      return event.type === "call.summary.completed" ? onSummary(conn, event) : onTranscript(conn, event);
    }
    case "contact.updated":
      return onContact(conn, event);
    default:
      return { handled: false, note: `ignored ${event.type}` };
  }
}

// ---------------------------------------------------------------------------------------------

async function onMessage(conn: Conn, event: QuoEvent): Promise<QuoOutcome> {
  const m = event.data.resource as unknown as QuoMessageResource;
  const line = await lineFor(conn, event.data.context);
  const phone = counterpart(event, m.direction);
  const incoming = m.direction === "incoming";
  const contact = phone
    ? incoming
      ? (await findOrCreateLeadByPhone(conn, phone, { brand: line?.brand, lineLabel: line?.label, lineNumber: line?.number })).contact
      : await findContactByPhone(conn, phone)
    : null;
  const sensitive = line?.lineKey === AIRNYC_LINE;
  const text = [m.text ?? "", ...(m.media ?? []).map((x) => `[attachment] ${x.url}`)].filter(Boolean).join("\n");
  const status = event.type === "message.received" ? "received" : event.type.split(".")[1];

  const values = {
    type: "SMS" as const,
    direction: incoming ? ("INBOUND" as const) : ("OUTBOUND" as const),
    contactId: contact?.id,
    jobId: await soleOpenJob(conn, contact?.id),
    brand: line?.brand,
    channelLine: line?.lineKey ?? event.data.context?.phoneNumberId,
    fromAddress: incoming ? phone : (line?.number ?? null),
    toAddress: incoming ? (line?.number ?? null) : phone,
    externalId: m.id,
    externalUrl: event.data.links?.quo,
    threadKey: event.data.context?.conversationId,
    occurredAt: ts(m.createdAt) ?? new Date(),
    callStatus: status,
    // Inbound texts go through AI triage (SPEC §9.1); AIRnyc-line texts are sealed and never auto-sent to AI.
    triageStatus: incoming ? ("PENDING" as const) : ("SKIPPED" as const),
    raw: sensitive ? null : (event as unknown as Record<string, unknown>),
    ...(sensitive ? sealContent({ body: text }) : { body: text }),
  };
  const [row] = await conn
    .insert(s.activities)
    .values(values)
    .onConflictDoUpdate({
      target: [s.activities.type, s.activities.externalId],
      // Delivery-status events only advance the status; they never overwrite content.
      set: { callStatus: status, externalUrl: sql`coalesce(${s.activities.externalUrl}, excluded.external_url)`, updatedAt: new Date() },
    })
    .returning({ id: s.activities.id });
  return { handled: true, activityId: row.id };
}

// ---------------------------------------------------------------------------------------------

async function upsertCall(conn: Conn, callId: string, fields: Partial<typeof s.activities.$inferInsert>, update: Partial<typeof s.activities.$inferInsert>) {
  const [row] = await conn
    .insert(s.activities)
    .values({ type: "CALL", externalId: callId, triageStatus: "SKIPPED", ...fields })
    .onConflictDoUpdate({ target: [s.activities.type, s.activities.externalId], set: { ...update, updatedAt: new Date() } })
    .returning();
  return row;
}

async function onCall(conn: Conn, event: QuoEvent): Promise<QuoOutcome> {
  const c = event.data.resource as unknown as QuoCallResource;
  const line = await lineFor(conn, event.data.context);
  const phone = counterpart(event, c.direction);
  const incoming = c.direction === "incoming";
  const contact = phone
    ? (await findOrCreateLeadByPhone(conn, phone, { brand: line?.brand, lineLabel: line?.label, lineNumber: line?.number })).contact
    : null;
  const status = event.type === "call.missed" ? "missed" : (c.status ?? "unknown");
  const missed = incoming && MISSED_STATUSES.has(status);
  const subject = `${incoming ? "Inbound" : "Outbound"} call${missed ? " — missed" : ""}${c.hasVoicemail ? " (voicemail)" : ""}`;

  const core = {
    direction: incoming ? ("INBOUND" as const) : ("OUTBOUND" as const),
    contactId: contact?.id,
    jobId: await soleOpenJob(conn, contact?.id),
    brand: line?.brand,
    channelLine: line?.lineKey ?? event.data.context?.phoneNumberId,
    fromAddress: incoming ? phone : (line?.number ?? null),
    toAddress: incoming ? (line?.number ?? null) : phone,
    externalUrl: event.data.links?.quo,
    threadKey: event.data.context?.conversationId,
    occurredAt: ts(c.createdAt) ?? new Date(),
    callStatus: status,
    durationSeconds: c.duration ?? null,
    subject,
  };
  // Summary/transcript may already exist (out-of-order) — only touch call-owned columns.
  const row = await upsertCall(conn, c.id, { ...core, raw: line?.lineKey === AIRNYC_LINE ? null : ({ call: event } as Record<string, unknown>) }, core);

  const toSend: string[] = [];
  if (missed && line?.missedCallTextback && contact && !contact.doNotContact) {
    const approvedId = await missedCallTextback(conn, { activityId: row.id, line, contactId: contact.id, to: phone!, firstName: contact.firstName, at: core.occurredAt });
    if (approvedId) toSend.push(approvedId);
  }
  return { handled: true, activityId: row.id, toSend };
}

async function missedCallTextback(
  conn: Conn,
  o: { activityId: string; line: Line; contactId: string; to: string; firstName: string | null; at: Date },
): Promise<string | null> {
  // Once per call, and not more than once per number per 24h (repeat callers).
  const [recent] = await conn
    .select({ id: s.outboundMessages.id })
    .from(s.outboundMessages)
    .where(
      and(
        eq(s.outboundMessages.source, "MISSED_CALL"),
        eq(s.outboundMessages.toAddress, o.to),
        gte(s.outboundMessages.createdAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    )
    .limit(1);
  if (recent) return null;

  const [cfg] = await conn.select().from(s.settings);
  const key = cfg && isWithinBusinessHours(o.at, cfg.businessHours) ? "MISSED_CALL" : "MISSED_CALL_AFTER_HOURS";
  const [tpl] = await conn.select().from(s.messageTemplates).where(and(eq(s.messageTemplates.key, key), eq(s.messageTemplates.active, true)));
  if (!tpl) return null;
  const brand = BRAND_INFO[o.line.brand];
  const { text } = renderTemplate(tpl.body, { first_name: o.firstName, brand_name: brand.name, brand_phone: brand.phone });

  const draft = await createDraft(conn, {
    channel: "SMS",
    source: "MISSED_CALL",
    templateKey: key,
    toAddress: o.to,
    fromLineId: o.line.id,
    body: text,
    brand: o.line.brand,
    contactId: o.contactId,
    replyToActivityId: o.activityId,
  });

  if (cfg?.autoSendSms) {
    await approve(conn, draft.id, null); // auto-send: no human approver; sent after commit
    return draft.id;
  } else {
    await conn.insert(s.tasks).values({
      title: `Approve missed-call text to ${o.to}`,
      description: "A missed-call text-back is waiting in the Outbox (auto-send SMS is off).",
      source: "SYSTEM_RULE",
      contactId: o.contactId,
      dueAt: new Date(Date.now() + 3600_000),
    });
    return null;
  }
}

async function onSummary(conn: Conn, event: QuoEvent): Promise<QuoOutcome> {
  const r = event.data.resource as unknown as QuoSummaryResource;
  if (r.processingStatus && r.processingStatus !== "completed") return { handled: false, note: `summary ${r.processingStatus}` };
  const summary = (r.summary ?? []).join("\n");
  const nextSteps = r.nextSteps ?? [];

  // Lock the row so two deliveries of the summary can't both create next-step tasks.
  const [before] = await conn
    .select({ id: s.activities.id, nextSteps: s.activities.nextSteps, sensitive: s.activities.sensitive, sensitiveEnc: s.activities.sensitiveEnc })
    .from(s.activities)
    .where(and(eq(s.activities.type, "CALL"), eq(s.activities.externalId, r.callId)))
    .for("update");
  const seal = before?.sensitive || (await lineFor(conn, event.data.context))?.lineKey === AIRNYC_LINE;
  // AIRnyc: keep the summary sealed; next steps become tasks without the call's content.
  const content = seal ? mergeSealed(before?.sensitiveEnc ?? null, { summary }) : { summary };
  const row = await upsertCall(
    conn,
    r.callId,
    { ...content, nextSteps, externalUrl: event.data.links?.quo, raw: seal ? null : ({ summary: event } as Record<string, unknown>) },
    { ...content, nextSteps },
  );
  if (before?.nextSteps == null && nextSteps.length) {
    await conn.insert(s.tasks).values(
      nextSteps.map((step) => ({
        title: step.length > 280 ? `${step.slice(0, 277)}…` : step,
        description: `From Quo call summary.`,
        source: "QUO_NEXT_STEP" as const,
        contactId: row.contactId,
        jobId: row.jobId,
        dueAt: new Date(Date.now() + 24 * 3600_000),
      })),
    );
  }
  return { handled: true, activityId: row.id };
}

async function onTranscript(conn: Conn, event: QuoEvent): Promise<QuoOutcome> {
  const r = event.data.resource as unknown as QuoTranscriptResource;
  if (r.processingStatus && r.processingStatus !== "completed") return { handled: false, note: `transcript ${r.processingStatus}` };
  const transcript = (r.dialogue ?? []).map((d) => `${d.identifier ?? (d.userId ? "ESS" : "Caller")}: ${d.content}`).join("\n");
  const [before] = await conn
    .select({ sensitive: s.activities.sensitive, sensitiveEnc: s.activities.sensitiveEnc })
    .from(s.activities)
    .where(and(eq(s.activities.type, "CALL"), eq(s.activities.externalId, r.callId)))
    .for("update");
  const seal = before?.sensitive || (await lineFor(conn, event.data.context))?.lineKey === AIRNYC_LINE;
  // A sealed (AIRnyc) transcript isn't visible without decrypting, so mark its arrival for the
  // AI call-extraction worker (SPEC §9.3), which picks up calls with a transcript.
  const content = seal ? { ...mergeSealed(before?.sensitiveEnc ?? null, { transcript }), aiClassification: { sealedTranscript: true } } : { transcript };
  const row = await upsertCall(conn, r.callId, { ...content, raw: seal ? null : ({ transcript: event } as Record<string, unknown>) }, content);
  return { handled: true, activityId: row.id };
}

async function onContact(conn: Conn, event: QuoEvent): Promise<QuoOutcome> {
  const r = event.data.resource as unknown as QuoContactResource;
  for (const p of r.phoneNumbers ?? []) {
    const c = await findContactByPhone(conn, p.value);
    if (!c) continue;
    await conn
      .update(s.contacts)
      .set({
        quoContactId: r.id,
        // Only fill blanks — the CRM is the source of truth for names it already has.
        ...(c.firstName ? {} : { firstName: r.firstName ?? null }),
        ...(c.lastName ? {} : { lastName: r.lastName ?? null }),
      })
      .where(and(eq(s.contacts.id, c.id), isNull(s.contacts.archivedAt)));
    return { handled: true };
  }
  return { handled: false, note: "no matching CRM contact" };
}
