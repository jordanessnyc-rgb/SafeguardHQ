/**
 * The conversation view in Messages: one row per person (see conversationKey in ./inbox), a chat-style
 * thread, personal read state (Unread / Recent) and stars. Runs in the viewer's RLS transaction.
 *
 * Unread = inbound messages after the viewer last opened that conversation; a conversation they have
 * never opened counts its inbound messages from the last 7 days, so history isn't all "unread".
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { col } from "@/lib/db/sql";
import { keySql, notesFor, ownerSql, type InboxView } from "./inbox";

export const CONV_TABS = ["unread", "all", "recent", "starred"] as const;
export type ConvTab = (typeof CONV_TABS)[number];

export type ConversationRow = {
  key: string;
  lastAt: Date;
  lastId: string;
  lastType: string;
  lastDirection: string | null;
  lastSubject: string | null;
  snippet: string | null;
  sensitive: boolean;
  contactId: string | null;
  firstName: string | null;
  lastName: string | null;
  address: string | null;
  owner: string | null;
  mine: boolean;
  owned: boolean;
  unread: number;
  starred: boolean;
  lastReadAt: Date | null;
};

const MESSAGE_TYPES = sql`('EMAIL_IN', 'EMAIL_OUT', 'SMS', 'CALL')`;
const live = sql`${col(s.activities.archivedAt)} is null and not (coalesce(${col(s.activities.raw)}, '{}'::jsonb) ? 'trashed')`;

/** Every conversation of the last 180 days (newest first, up to 500), with the viewer's unread/star state. */
export async function listConversations(tx: Tx, opts: { me: string; q?: string }): Promise<ConversationRow[]> {
  const q = opts.q?.trim();
  const rows = await tx.execute<Record<string, unknown>>(sql`
    with m as (
      select ${col(s.activities.id)} as id, ${col(s.activities.type)}::text as type, ${col(s.activities.direction)}::text as direction,
        ${col(s.activities.subject)} as subject, ${col(s.activities.body)} as body, ${col(s.activities.occurredAt)} as occurred_at,
        ${col(s.activities.contactId)} as contact_id, ${col(s.activities.sensitive)} as sensitive,
        ${col(s.activities.fromAddress)} as from_address, ${col(s.activities.toAddress)} as to_address,
        ${keySql} as key, ${ownerSql} as owner
      from ${s.activities}
      where ${col(s.activities.type)}::text in ${MESSAGE_TYPES} and ${live} and ${col(s.activities.occurredAt)} > now() - interval '180 days'
    ), c as (
      select key, max(occurred_at) as last_at, (array_agg(id order by occurred_at desc))[1] as last_id,
        (array_agg(owner order by occurred_at desc) filter (where owner is not null))[1] as owner,
        bool_or(owner = ${opts.me}) as mine, bool_or(owner is not null) as owned
      from m group by key
    )
    select c.key, c.last_at, c.last_id, c.owner, c.mine, c.owned,
      l.type as last_type, l.direction as last_direction, l.subject as last_subject, left(l.body, 200) as snippet, l.sensitive,
      l.contact_id, ct.first_name, ct.last_name,
      case when l.direction = 'INBOUND' then l.from_address else l.to_address end as address,
      (select count(*) from m where m.key = c.key and m.direction = 'INBOUND'
         and m.occurred_at > coalesce(r.last_read_at, now() - interval '7 days'))::int as unread,
      st.created_at is not null as starred, r.last_read_at
    from c
    join m l on l.id = c.last_id
    left join ${s.contacts} ct on ct.id = l.contact_id
    left join ${s.conversationReads} r on r.user_id = ${opts.me} and r.conversation_key = c.key
    left join ${s.conversationStars} st on st.user_id = ${opts.me} and st.conversation_key = c.key
    ${q ? sql`where (coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '') ilike ${`%${q}%`} or c.key ilike ${`%${q}%`}
                 or exists (select 1 from m m2 where m2.key = c.key and (m2.subject ilike ${`%${q}%`} or m2.body ilike ${`%${q}%`})))` : sql``}
    order by c.last_at desc
    limit 500`);
  return rows.rows.map((r) => ({
    key: String(r.key),
    lastAt: new Date(r.last_at as string),
    lastId: String(r.last_id),
    lastType: String(r.last_type),
    lastDirection: (r.last_direction as string | null) ?? null,
    lastSubject: (r.last_subject as string | null) ?? null,
    snippet: (r.snippet as string | null) ?? null,
    sensitive: Boolean(r.sensitive),
    contactId: (r.contact_id as string | null) ?? null,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    owner: (r.owner as string | null) ?? null,
    mine: Boolean(r.mine),
    owned: Boolean(r.owned),
    unread: Number(r.unread ?? 0),
    starred: Boolean(r.starred),
    lastReadAt: r.last_read_at ? new Date(r.last_read_at as string) : null,
  }));
}

/** Applies a scope (Team / My / Unassigned) and a tab (Unread / All / Recent / Starred). */
export function filterConversations(rows: ConversationRow[], view: InboxView, tab: ConvTab): ConversationRow[] {
  const scoped = rows.filter((r) => (view === "mine" ? r.mine : view === "unassigned" ? !r.owned : true));
  if (tab === "unread") return scoped.filter((r) => r.unread > 0);
  if (tab === "starred") return scoped.filter((r) => r.starred);
  if (tab === "recent") return scoped.filter((r) => r.lastReadAt).sort((a, b) => b.lastReadAt!.getTime() - a.lastReadAt!.getTime()).slice(0, 50);
  return scoped;
}

export type ThreadItem =
  | { kind: "message"; a: typeof s.activities.$inferSelect }
  | { kind: "note"; id: string; body: string | null; createdAt: Date; authorId: string | null };

/** Everything in one conversation, oldest first: emails, texts, calls and the team's internal comments. */
export async function loadThread(tx: Tx, key: string): Promise<ThreadItem[]> {
  const messages = await tx
    .select()
    .from(s.activities)
    .where(and(inArray(s.activities.type, ["EMAIL_IN", "EMAIL_OUT", "SMS", "CALL"]), sql`${keySql} = ${key}`, sql`not (coalesce(${s.activities.raw}, '{}'::jsonb) ? 'trashed')`))
    .orderBy(asc(s.activities.occurredAt))
    .limit(300);
  const notes = await notesFor(tx, key);
  const items: ThreadItem[] = [
    ...messages.map((a) => ({ kind: "message" as const, a })),
    ...notes.map((n) => ({ kind: "note" as const, id: n.id, body: n.body, createdAt: n.createdAt, authorId: n.authorId })),
  ];
  return items.sort((x, y) => (x.kind === "message" ? x.a.occurredAt : x.createdAt).getTime() - (y.kind === "message" ? y.a.occurredAt : y.createdAt).getTime());
}

export async function markConversationRead(tx: Tx, me: string, keys: string[]) {
  if (!keys.length) return;
  const now = new Date();
  await tx
    .insert(s.conversationReads)
    .values(keys.map((conversationKey) => ({ userId: me, conversationKey, lastReadAt: now })))
    .onConflictDoUpdate({ target: [s.conversationReads.userId, s.conversationReads.conversationKey], set: { lastReadAt: now } });
}

/** Stars or unstars a conversation for the viewer. Returns the new state. */
export async function toggleStar(tx: Tx, me: string, key: string): Promise<boolean> {
  const removed = await tx
    .delete(s.conversationStars)
    .where(and(eq(s.conversationStars.userId, me), eq(s.conversationStars.conversationKey, key)))
    .returning();
  if (removed.length) return false;
  await tx.insert(s.conversationStars).values({ userId: me, conversationKey: key }).onConflictDoNothing();
  return true;
}
