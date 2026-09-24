/**
 * FreshBooks client import with duplicate review (SPEC §6.2). Import never auto-merges: each
 * FreshBooks client lands as PENDING with a suggested CRM match (same email → same company name →
 * same person name) and a human links it, creates a new CRM record, or ignores it.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import type { FbClient, FreshBooksClient } from "@/lib/integrations/freshbooks";
import { toE164 } from "@/lib/phone";

type Conn = Db | Tx;

const COMPANY_NOISE = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|pc|pllc|the)\b/g;
export const normCompany = (v: string | null | undefined) =>
  (v ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();
const normPerson = (f?: string | null, l?: string | null) => `${f ?? ""} ${l ?? ""}`.toLowerCase().replace(/[^a-z ]+/g, "").replace(/\s+/g, " ").trim();

export async function suggestMatch(conn: Conn, c: { email?: string | null; organization?: string | null; fname?: string | null; lname?: string | null }) {
  const email = c.email?.trim().toLowerCase();
  if (email) {
    const [org] = await conn.select({ id: s.organizations.id }).from(s.organizations).where(and(isNull(s.organizations.archivedAt), sql`lower(${s.organizations.email}) = ${email}`)).limit(1);
    if (org) return { orgId: org.id, contactId: null, reason: "same email" };
    const [ct] = await conn
      .select({ id: s.contacts.id, orgId: s.contacts.orgId })
      .from(s.contacts)
      .where(and(isNull(s.contacts.archivedAt), sql`exists (select 1 from unnest(${s.contacts.emails}) e where lower(e) = ${email})`))
      .limit(1);
    if (ct) return { orgId: c.organization ? ct.orgId : null, contactId: ct.id, reason: "same email" };
  }
  const company = normCompany(c.organization);
  if (company.length >= 3) {
    const orgs = await conn.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations).where(isNull(s.organizations.archivedAt));
    const hit = orgs.find((o) => normCompany(o.name) === company);
    if (hit) return { orgId: hit.id, contactId: null, reason: "same company name" };
  }
  const person = normPerson(c.fname, c.lname);
  if (person.includes(" ")) {
    const [ct] = await conn
      .select({ id: s.contacts.id })
      .from(s.contacts)
      .where(and(isNull(s.contacts.archivedAt), sql`lower(trim(coalesce(${s.contacts.firstName},'') || ' ' || coalesce(${s.contacts.lastName},''))) = ${person}`))
      .limit(1);
    if (ct) return { orgId: null, contactId: ct.id, reason: "same person name" };
  }
  return { orgId: null, contactId: null, reason: null };
}

async function upsertImported(conn: Conn, c: FbClient) {
  const id = String(c.id);
  const [linkedOrg] = await conn.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.freshbooksClientId, id));
  const [linkedContact] = linkedOrg ? [] : await conn.select({ id: s.contacts.id }).from(s.contacts).where(eq(s.contacts.freshbooksClientId, id));
  const [existing] = await conn.select().from(s.freshbooksClients).where(eq(s.freshbooksClients.freshbooksClientId, id));
  const base = {
    freshbooksClientId: id,
    organization: c.organization || null,
    firstName: c.fname || null,
    lastName: c.lname || null,
    email: c.email || null,
    phone: c.mob_phone || c.bus_phone || null,
    raw: c as unknown as Record<string, unknown>,
  };
  if (linkedOrg || linkedContact) {
    const values = { ...base, matchStatus: "LINKED" as const, linkedOrgId: linkedOrg?.id ?? null, linkedContactId: linkedContact?.id ?? null };
    await conn.insert(s.freshbooksClients).values(values).onConflictDoUpdate({ target: s.freshbooksClients.freshbooksClientId, set: values });
    return "LINKED";
  }
  if (existing && existing.matchStatus !== "PENDING") {
    await conn.update(s.freshbooksClients).set(base).where(eq(s.freshbooksClients.freshbooksClientId, id));
    return existing.matchStatus;
  }
  const m = await suggestMatch(conn, c);
  const values = { ...base, matchStatus: "PENDING" as const, suggestedOrgId: m.orgId, suggestedContactId: m.contactId, matchReason: m.reason };
  await conn.insert(s.freshbooksClients).values(values).onConflictDoUpdate({ target: s.freshbooksClients.freshbooksClientId, set: values });
  return "PENDING";
}

/** Pages through every active FreshBooks client. */
export async function importFreshbooksClients(db: Db, fb: FreshBooksClient) {
  let page = 1;
  let pages = 1;
  const counts: Record<string, number> = {};
  do {
    const r = await fb.listClients(page);
    pages = r.pages;
    for (const c of r.clients.filter((x) => (x.vis_state ?? 0) === 0)) {
      const st = await upsertImported(db, c);
      counts[st] = (counts[st] ?? 0) + 1;
    }
    page++;
  } while (page <= pages);
  return counts;
}

/** client.create / client.update webhook: keep the import row current. */
export async function refreshImportedClient(db: Db, fb: FreshBooksClient, id: string) {
  const c = await fb.getClient(id);
  if ((c.vis_state ?? 0) !== 0) return;
  await upsertImported(db, c);
}

export type Resolution = { action: "link"; orgId?: string | null; contactId?: string | null } | { action: "create" } | { action: "ignore" };

export async function resolveImportedClient(conn: Conn, fbId: string, r: Resolution) {
  const [row] = await conn.select().from(s.freshbooksClients).where(eq(s.freshbooksClients.freshbooksClientId, fbId));
  if (!row) throw new Error("FreshBooks client not found in the import list.");
  if (r.action === "ignore") {
    await conn.update(s.freshbooksClients).set({ matchStatus: "IGNORED" }).where(eq(s.freshbooksClients.freshbooksClientId, fbId));
    return;
  }
  let orgId: string | null = null;
  let contactId: string | null = null;
  if (r.action === "link") {
    orgId = r.orgId ?? null;
    contactId = r.contactId ?? null;
    if (!orgId && !contactId) throw new Error("Pick an organization or contact to link.");
  } else {
    if (row.organization) {
      [{ id: orgId }] = await conn.insert(s.organizations).values({ name: row.organization, type: "OTHER", email: row.email }).returning({ id: s.organizations.id });
    }
    if (row.firstName || row.lastName) {
      [{ id: contactId }] = await conn
        .insert(s.contacts)
        .values({ firstName: row.firstName, lastName: row.lastName, orgId, emails: row.email ? [row.email] : [], phones: [toE164(row.phone)].filter((p): p is string => Boolean(p)), source: "MANUAL" })
        .returning({ id: s.contacts.id });
    }
    if (!orgId && !contactId) throw new Error("This FreshBooks client has no name or company to create from.");
  }
  // The billing link lives on the organization when there is one (invoices go to the company).
  if (orgId) await conn.update(s.organizations).set({ freshbooksClientId: fbId }).where(eq(s.organizations.id, orgId));
  else await conn.update(s.contacts).set({ freshbooksClientId: fbId }).where(eq(s.contacts.id, contactId!));
  await conn
    .update(s.freshbooksClients)
    .set({ matchStatus: r.action === "link" ? "LINKED" : "CREATED", linkedOrgId: orgId, linkedContactId: contactId })
    .where(eq(s.freshbooksClients.freshbooksClientId, fbId));
}

