/**
 * Team inbox & internal chat. Everything runs in the caller's RLS transaction (staff only).
 *
 *  - A conversation is identified by its message's thread key (email thread root / Quo conversation),
 *    or the message's own id when it has none, so replies in an assigned thread follow automatically.
 *  - Every message belongs to at most one team member (its "owner"), checked in this order:
 *      1. the person its conversation is assigned to;
 *      2. the person who sent it (from the CRM: outbound_messages.approved_by; from their own
 *         mailbox: from_address is their login email);
 *      3. the person it was emailed to (their login email in To or Cc);
 *      4. for texts: the person who last texted that number from the CRM, so replies to my texts
 *         are mine too.
 *  - My inbox = messages whose owner is me (received, sent, and my text conversations, in one list).
 *  - Unassigned = messages with no owner (e.g. mail to sales@ nobody has taken).
 *  - Internal notes are activities of type NOTE / direction INTERNAL: there is no code path that sends
 *    an activity, so a note can never reach the client.
 */
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { col } from "@/lib/db/sql";
import { mentionedIds, type Member } from "./mentions";

export type InboxView = "team" | "mine" | "unassigned";

export const conversationKey = (a: { threadKey: string | null; id: string }) => a.threadKey ?? a.id;
const keySql = sql`coalesce(${col(s.activities.threadKey)}, ${col(s.activities.id)}::text)`;

/**
 * True when the message was addressed to `email` (To or Cc). Uses the parsed headers kept in
 * raw.email (inbound mail) and falls back to to_address (outbound / older rows). Case-insensitive.
 */
function addressedTo(email: SQL): SQL {
  return sql`(
    exists (select 1 from jsonb_array_elements(
      coalesce(${col(s.activities.raw)}->'email'->'to', '[]'::jsonb) || coalesce(${col(s.activities.raw)}->'email'->'cc', '[]'::jsonb)) r
      where lower(r->>'address') = lower(${email}))
    or ${col(s.activities.toAddress)} ilike '%' || ${email} || '%')`;
}
const isTeam = (id: SQL) => sql`${id} in (select p.user_id from ${s.profiles} p where p.role in ('OWNER', 'VA'))`;
const counterpart = sql`(case when ${col(s.activities.direction)} = 'INBOUND' then ${col(s.activities.fromAddress)} else ${col(s.activities.toAddress)} end)`;

/** The team member a listed message belongs to (see the order at the top of this file), or null. */
export const ownerSql = sql<string | null>`coalesce(
  (select ca.assignee from ${s.conversationAssignments} ca where ca.conversation_key = ${keySql}),
  (select om.approved_by from ${s.outboundMessages} om
    where ${col(s.activities.direction)} = 'OUTBOUND' and om.external_id = ${col(s.activities.externalId)} and ${isTeam(sql`om.approved_by`)} limit 1),
  (select p.user_id from ${s.profiles} p
    where p.role in ('OWNER', 'VA') and ${col(s.activities.direction)} = 'OUTBOUND' and lower(${col(s.activities.fromAddress)}) = lower(p.email) limit 1),
  (select p.user_id from ${s.profiles} p where p.role in ('OWNER', 'VA') and ${addressedTo(sql`p.email`)} limit 1),
  (select om.approved_by from ${s.outboundMessages} om
    where ${col(s.activities.type)} = 'SMS' and om.channel = 'SMS' and om.status = 'SENT' and ${isTeam(sql`om.approved_by`)}
      and om.to_address = ${counterpart}
    order by om.sent_at desc nulls last limit 1))`;

/** WHERE fragment (on `activities`) for a Messages view. */
export function viewWhere(view: InboxView, user: { id: string; email: string }): SQL | undefined {
  if (view === "mine") return sql`${ownerSql} = ${user.id}`;
  if (view === "unassigned") return sql`${ownerSql} is null`;
  return undefined;
}

/** OWNER + VA accounts: the people who can be assigned, mentioned and chat. */
export async function teamMembers(tx: Tx): Promise<(Member & { email: string })[]> {
  const rows = await tx
    .select({ id: s.profiles.userId, name: s.profiles.fullName, email: s.profiles.email })
    .from(s.profiles)
    .where(inArray(s.profiles.role, ["OWNER", "VA"]))
    .orderBy(asc(s.profiles.fullName), asc(s.profiles.email));
  return rows.map((r) => ({ id: r.id, name: r.name?.trim() || r.email.split("@")[0], email: r.email }));
}

/** Where a message opens in Messages (the right box, so ?id= finds it). */
export function messageHref(a: { id: string; direction: string | null; archivedAt: Date | null }) {
  const box = a.archivedAt ? "archived" : a.direction === "OUTBOUND" ? "sent" : "inbox";
  return `/inbox?box=${box}&id=${a.id}`;
}

export async function assignmentFor(tx: Tx, key: string) {
  const [row] = await tx.select().from(s.conversationAssignments).where(eq(s.conversationAssignments.conversationKey, key));
  return row ?? null;
}

/** Assigns (or, with null, unassigns) a conversation, and tells the new assignee unless it's you. */
export async function assignConversation(
  tx: Tx,
  opts: { activity: { id: string; threadKey: string | null; direction: string | null; archivedAt: Date | null; subject: string | null; type: string }; assignee: string | null; actor: { id: string; name: string } },
) {
  const key = conversationKey(opts.activity);
  if (!opts.assignee) {
    await tx.delete(s.conversationAssignments).where(eq(s.conversationAssignments.conversationKey, key));
    return;
  }
  const values = { conversationKey: key, assignee: opts.assignee, assignedBy: opts.actor.id, assignedAt: new Date() };
  await tx.insert(s.conversationAssignments).values(values).onConflictDoUpdate({ target: s.conversationAssignments.conversationKey, set: values });
  if (opts.assignee !== opts.actor.id) {
    const what = opts.activity.type === "SMS" ? "a text conversation" : `“${opts.activity.subject || "(no subject)"}”`;
    await tx.insert(s.notifications).values({ userId: opts.assignee, kind: "ASSIGNED", actorId: opts.actor.id, title: `${opts.actor.name} assigned you ${what}`, href: messageHref(opts.activity) });
  }
}

/** Internal notes on a conversation, oldest first. */
export async function notesFor(tx: Tx, key: string) {
  return tx
    .select({ id: s.activities.id, body: s.activities.body, createdAt: s.activities.occurredAt, authorId: s.activities.createdBy })
    .from(s.activities)
    .where(and(eq(s.activities.type, "NOTE"), eq(s.activities.direction, "INTERNAL"), sql`${s.activities.raw}->>'conversationKey' = ${key}`))
    .orderBy(asc(s.activities.occurredAt))
    .limit(200);
}

/**
 * Adds an internal note to a message's conversation and notifies anyone @mentioned. The note also
 * shows on the job's and contact's timeline (as an internal note). Not allowed on AIRnyc / sealed
 * messages, where member details belong in the encrypted case record (CLAUDE.md rule 5).
 */
export async function addInternalNote(
  tx: Tx,
  opts: { activity: typeof s.activities.$inferSelect; body: string; author: { id: string; name: string }; members: Member[] },
) {
  const a = opts.activity;
  if (a.sensitive || a.airnycCaseId) throw new Error("Notes can't be added to AIRnyc messages. Use the AIRnyc case instead.");
  const body = opts.body.trim();
  if (!body) throw new Error("Write a note first.");
  if (body.length > 4000) throw new Error("Notes are limited to 4,000 characters.");
  const key = conversationKey(a);
  const mentions = mentionedIds(body, opts.members, opts.author.id);
  const [note] = await tx
    .insert(s.activities)
    .values({
      type: "NOTE",
      direction: "INTERNAL",
      subject: "Internal note",
      body,
      contactId: a.contactId,
      jobId: a.jobId,
      propertyId: a.propertyId,
      brand: a.brand,
      triageStatus: "SKIPPED",
      raw: { internalNote: true, conversationKey: key, onActivityId: a.id, mentions },
    })
    .returning({ id: s.activities.id });
  if (mentions.length) {
    const what = a.type === "SMS" ? "a text conversation" : `“${a.subject || "(no subject)"}”`;
    await tx.insert(s.notifications).values(
      mentions.map((userId) => ({ userId, kind: "MENTION_NOTE" as const, actorId: opts.author.id, title: `${opts.author.name} mentioned you on ${what}`, body: body.slice(0, 280), href: messageHref(a) })),
    );
  }
  return { id: note.id, mentions };
}

/** Posts to team chat and notifies anyone @mentioned. */
export async function postTeamMessage(tx: Tx, opts: { body: string; author: { id: string; name: string }; members: Member[] }) {
  const body = opts.body.trim();
  if (!body) throw new Error("Write a message first.");
  if (body.length > 4000) throw new Error("Messages are limited to 4,000 characters.");
  const mentions = mentionedIds(body, opts.members, opts.author.id);
  const [msg] = await tx.insert(s.teamMessages).values({ authorId: opts.author.id, body, mentions }).returning();
  if (mentions.length)
    await tx.insert(s.notifications).values(mentions.map((userId) => ({ userId, kind: "MENTION_CHAT" as const, actorId: opts.author.id, title: `${opts.author.name} mentioned you in Team chat`, body: body.slice(0, 280), href: `/team-chat#m-${msg.id}` })));
  // Posting counts as having read the room.
  await markChatRead(tx, opts.author.id);
  return msg;
}

export async function recentTeamMessages(tx: Tx, limit = 150) {
  const rows = await tx
    .select({ id: s.teamMessages.id, authorId: s.teamMessages.authorId, body: s.teamMessages.body, createdAt: s.teamMessages.createdAt })
    .from(s.teamMessages)
    .where(isNull(s.teamMessages.deletedAt))
    .orderBy(desc(s.teamMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function markChatRead(tx: Tx, userId: string) {
  await tx.insert(s.chatReads).values({ userId, lastReadAt: new Date() }).onConflictDoUpdate({ target: s.chatReads.userId, set: { lastReadAt: new Date() } });
}

/** Unread team-chat messages (from others) + unread notifications, for the nav badge. */
export async function unreadForNav(tx: Tx, userId: string): Promise<number> {
  const [read] = await tx.select({ at: s.chatReads.lastReadAt }).from(s.chatReads).where(eq(s.chatReads.userId, userId));
  const [chat] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(s.teamMessages)
    .where(and(isNull(s.teamMessages.deletedAt), ne(s.teamMessages.authorId, userId), read ? gt(s.teamMessages.createdAt, read.at) : undefined));
  const [notes] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(s.notifications)
    .where(and(eq(s.notifications.userId, userId), isNull(s.notifications.readAt), ne(s.notifications.kind, "MENTION_CHAT")));
  return chat.n + notes.n;
}

export async function myNotifications(tx: Tx, userId: string, limit = 30) {
  return tx.select().from(s.notifications).where(eq(s.notifications.userId, userId)).orderBy(desc(s.notifications.createdAt)).limit(limit);
}

export async function markNotificationsRead(tx: Tx, userId: string, ids?: string[]) {
  await tx
    .update(s.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(s.notifications.userId, userId), isNull(s.notifications.readAt), ids?.length ? inArray(s.notifications.id, ids) : undefined));
}
