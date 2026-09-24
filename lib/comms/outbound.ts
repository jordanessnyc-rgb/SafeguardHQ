/**
 * Outbound SMS/email (CLAUDE.md rule 6): every message is a row in outbound_messages that starts
 * as DRAFT. It is sent only after a person approves it — or immediately when the matching
 * settings.auto_send_* flag is on. Sending is guarded by a status compare-and-set so a double
 * click / retry can't send twice.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { toGsmFriendly, type QuoClient } from "@/lib/integrations/quo";
import { sealContent } from "./sensitive";

type Conn = Db | Tx;
export type Outbound = typeof s.outboundMessages.$inferSelect;

export type MailSender = {
  send(msg: { from: string; to: string; subject: string; text: string; inReplyTo?: string | null }): Promise<{ messageId: string }>;
};

export type SendDeps = { quo: QuoClient | null; mail: MailSender | null };

export async function createDraft(conn: Conn, values: typeof s.outboundMessages.$inferInsert): Promise<Outbound> {
  const [row] = await conn.insert(s.outboundMessages).values({ ...values, status: "DRAFT" }).returning();
  return row;
}

/** Mark approved. Only DRAFT/FAILED messages can be approved. */
export async function approve(conn: Conn, id: string, approver: string | null, edits?: { body?: string; subject?: string | null }) {
  const [row] = await conn
    .update(s.outboundMessages)
    .set({ status: "APPROVED", approvedBy: approver, approvedAt: new Date(), error: null, ...(edits ?? {}) })
    .where(and(eq(s.outboundMessages.id, id), inArray(s.outboundMessages.status, ["DRAFT", "FAILED"])))
    .returning();
  if (!row) throw new Error("This message was already sent or discarded.");
  return row;
}

/** Sends an APPROVED message. Returns the updated row (SENT or FAILED). */
export async function sendApproved(conn: Conn, id: string, deps: SendDeps): Promise<Outbound> {
  const [claimed] = await conn
    .update(s.outboundMessages)
    .set({ status: "SENDING" })
    .where(and(eq(s.outboundMessages.id, id), eq(s.outboundMessages.status, "APPROVED")))
    .returning();
  if (!claimed) throw new Error("Message is not approved (or is already being sent).");

  try {
    let externalId: string;
    let fromAddress: string | null = null;
    let channelLine: string | null = null;
    if (claimed.channel === "SMS") {
      if (!deps.quo) throw new Error("Quo isn't configured (QUO_API_KEY).");
      const [line] = claimed.fromLineId ? await conn.select().from(s.phoneLines).where(eq(s.phoneLines.id, claimed.fromLineId)) : [];
      if (!line) throw new Error("Pick which Quo line to send from.");
      const res = await deps.quo.sendSms({ from: line.quoPhoneNumberId, to: claimed.toAddress, content: toGsmFriendly(claimed.body) });
      externalId = res.id;
      fromAddress = line.number;
      channelLine = line.lineKey;
    } else {
      if (!deps.mail) throw new Error("Email sending isn't configured (TITAN_* settings).");
      const from = claimed.fromEmail ?? "sales@ess-nyc.com";
      const res = await deps.mail.send({ from, to: claimed.toAddress, subject: claimed.subject ?? "", text: claimed.body, inReplyTo: claimed.inReplyTo });
      externalId = res.messageId;
      fromAddress = from;
      channelLine = from;
    }

    const [sent] = await conn
      .update(s.outboundMessages)
      .set({ status: "SENT", sentAt: new Date(), externalId, error: null })
      .where(eq(s.outboundMessages.id, id))
      .returning();
    // Timeline entry. For SMS the Quo webhook (message.delivered) later upserts the same row by id.
    await conn
      .insert(s.activities)
      .values({
        type: claimed.channel === "SMS" ? "SMS" : "EMAIL_OUT",
        direction: "OUTBOUND",
        contactId: claimed.contactId,
        jobId: claimed.jobId,
        airnycCaseId: claimed.airnycCaseId,
        brand: claimed.brand,
        channelLine,
        fromAddress,
        toAddress: claimed.toAddress,
        subject: claimed.subject,
        body: claimed.body,
        // Messages about an AIRnyc case are stored sealed (CLAUDE.md rule 5).
        ...(claimed.airnycCaseId ? sealContent({ subject: claimed.subject, body: claimed.body }) : {}),
        externalId,
        threadKey: claimed.inReplyTo ?? externalId,
        callStatus: "sent",
        triageStatus: "SKIPPED",
      })
      .onConflictDoNothing();
    return sent;
  } catch (e) {
    const [failed] = await conn
      .update(s.outboundMessages)
      .set({ status: "FAILED", error: (e as Error).message.slice(0, 500) })
      .where(eq(s.outboundMessages.id, id))
      .returning();
    return failed;
  }
}
