import { and, isNull, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { toE164 } from "@/lib/phone";

type Conn = Db | Tx;

export async function findContactByPhone(conn: Conn, phone: string | null | undefined) {
  const e164 = toE164(phone);
  if (!e164) return null;
  const [c] = await conn
    .select()
    .from(s.contacts)
    .where(and(isNull(s.contacts.archivedAt), sql`${e164} = any(${s.contacts.phones})`))
    .limit(1);
  return c ?? null;
}

export async function findContactByEmail(conn: Conn, email: string | null | undefined) {
  if (!email) return null;
  const [c] = await conn
    .select()
    .from(s.contacts)
    .where(and(isNull(s.contacts.archivedAt), sql`exists (select 1 from unnest(${s.contacts.emails}) e where lower(e) = lower(${email}))`))
    .limit(1);
  return c ?? null;
}

/**
 * SPEC §6.1: no match → create a Lead contact + task "New inbound — qualify".
 * Returns the contact and whether it was just created.
 */
export async function findOrCreateLeadByPhone(
  conn: Conn,
  phone: string,
  opts: { brand?: "ESS" | "GAS_PRO"; lineLabel?: string; lineNumber?: string | null; name?: string | null } = {},
) {
  const existing = await findContactByPhone(conn, phone);
  if (existing) return { contact: existing, created: false };
  const e164 = toE164(phone) ?? phone;
  // Campaign attribution (SPEC §11): a new caller on a campaign's dedicated Quo number.
  const [campaign] = opts.lineNumber
    ? await conn.select({ id: s.campaigns.id }).from(s.campaigns).where(and(sql`${s.campaigns.tracking} ->> 'quoNumber' = ${opts.lineNumber}`, isNull(s.campaigns.archivedAt))).limit(1)
    : [];
  const [first, ...rest] = (opts.name ?? "").trim().split(/\s+/).filter(Boolean);
  const [contact] = await conn
    .insert(s.contacts)
    .values({
      firstName: first ?? null,
      lastName: rest.join(" ") || null,
      phones: [e164],
      source: campaign ? "MAILER_CAMPAIGN" : "QUO",
      campaignId: campaign?.id ?? null,
      brand: opts.brand ?? "ESS",
      notes: `Auto-created from inbound ${opts.lineLabel ? `on ${opts.lineLabel}` : "call/text"}.`,
    })
    .returning();
  await conn.insert(s.tasks).values({
    title: `New inbound — qualify ${e164}`,
    description: "Unknown number called or texted. Identify the person, link them to a property/org, or mark as spam.",
    source: "SYSTEM_RULE",
    contactId: contact.id,
    dueAt: new Date(Date.now() + 4 * 3600_000),
  });
  return { contact, created: true };
}
