/**
 * Tags (automation part 1): one shared list of labels that can be put on contacts, companies and jobs.
 * Everything here runs inside the caller's RLS transaction, so only staff (OWNER + VA) can read or change
 * tags; deleting a tag outright is OWNER-only (enforced by the tags RLS migration).
 */
import { and, asc, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { schema as s, type Tx } from "@/lib/db";
import { col } from "@/lib/db/sql";
import { isTagColor, type Tag, type TagColor } from "@/lib/tag-style";

export { isTagColor, type Tag, type TagColor };
export type TagEntity = "contact" | "organization" | "job";

const LINKS = {
  contact: { table: s.contactTags, key: s.contactTags.contactId },
  organization: { table: s.organizationTags, key: s.organizationTags.orgId },
  job: { table: s.jobTags, key: s.jobTags.jobId },
} as const;

export function isTagEntity(v: unknown): v is TagEntity {
  return v === "contact" || v === "organization" || v === "job";
}

/** Tag names: trimmed, single spaces, 1–40 characters. Returns null when unusable. */
export function cleanTagName(raw: unknown): string | null {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
}

/** Every active tag, A–Z. */
export async function listTags(tx: Tx): Promise<Tag[]> {
  return tx.select({ id: s.tags.id, name: s.tags.name, color: s.tags.color }).from(s.tags).where(isNull(s.tags.archivedAt)).orderBy(asc(sql`lower(${s.tags.name})`));
}

/** Tags with how many contacts, companies and jobs carry each (Settings → Tags). */
export async function tagUsage(tx: Tx) {
  const n = (link: (typeof LINKS)[TagEntity]) => tx.select({ tagId: link.table.tagId, n: count() }).from(link.table).groupBy(link.table.tagId);
  const [all, contacts, orgs, jobs] = await Promise.all([
    tx.select().from(s.tags).where(isNull(s.tags.archivedAt)).orderBy(asc(sql`lower(${s.tags.name})`)),
    n(LINKS.contact),
    n(LINKS.organization),
    n(LINKS.job),
  ]);
  const by = (rows: { tagId: string; n: number }[]) => new Map(rows.map((r) => [r.tagId, r.n]));
  const [c, o, j] = [by(contacts), by(orgs), by(jobs)];
  return all.map((t) => ({ ...t, contacts: c.get(t.id) ?? 0, organizations: o.get(t.id) ?? 0, jobs: j.get(t.id) ?? 0 }));
}

/** Tags on one record. */
export async function tagsFor(tx: Tx, entity: TagEntity, id: string): Promise<Tag[]> {
  return (await tagsForMany(tx, entity, [id])).get(id) ?? [];
}

/** Tags for a page of records in one query: record id → its tags (A–Z). */
export async function tagsForMany(tx: Tx, entity: TagEntity, ids: string[]): Promise<Map<string, Tag[]>> {
  const out = new Map<string, Tag[]>();
  if (!ids.length) return out;
  const link = LINKS[entity];
  const rows = await tx
    .select({ recordId: link.key, id: s.tags.id, name: s.tags.name, color: s.tags.color })
    .from(link.table)
    .innerJoin(s.tags, eq(s.tags.id, link.table.tagId))
    .where(and(inArray(link.key, ids), isNull(s.tags.archivedAt)))
    .orderBy(asc(sql`lower(${s.tags.name})`));
  for (const { recordId, ...tag } of rows) out.set(recordId, [...(out.get(recordId) ?? []), tag]);
  return out;
}

/**
 * Finds a tag by name (case-insensitive), creating it when it doesn't exist yet. A tag that was
 * archived comes back when someone uses its name again.
 */
export async function findOrCreateTag(tx: Tx, rawName: unknown, color: TagColor = "gray"): Promise<Tag> {
  const name = cleanTagName(rawName);
  if (!name) throw new Error("Tag names are 1–40 characters.");
  const [existing] = await tx.select().from(s.tags).where(eq(sql`lower(${s.tags.name})`, name.toLowerCase()));
  if (existing) {
    if (existing.archivedAt) await tx.update(s.tags).set({ archivedAt: null }).where(eq(s.tags.id, existing.id));
    return { id: existing.id, name: existing.name, color: existing.color };
  }
  const [created] = await tx.insert(s.tags).values({ name, color }).returning({ id: s.tags.id, name: s.tags.name, color: s.tags.color });
  return created;
}

/** Puts a tag on a record. Adding a tag the record already has is a no-op. Returns true if it was new. */
export async function addTag(tx: Tx, entity: TagEntity, recordId: string, tagId: string): Promise<boolean> {
  const rows =
    entity === "contact"
      ? await tx.insert(s.contactTags).values({ tagId, contactId: recordId }).onConflictDoNothing().returning({ tagId: s.contactTags.tagId })
      : entity === "organization"
        ? await tx.insert(s.organizationTags).values({ tagId, orgId: recordId }).onConflictDoNothing().returning({ tagId: s.organizationTags.tagId })
        : await tx.insert(s.jobTags).values({ tagId, jobId: recordId }).onConflictDoNothing().returning({ tagId: s.jobTags.tagId });
  return rows.length > 0;
}

export async function removeTag(tx: Tx, entity: TagEntity, recordId: string, tagId: string): Promise<void> {
  const link = LINKS[entity];
  await tx.delete(link.table).where(and(eq(link.table.tagId, tagId), eq(link.key, recordId)));
}

/** SQL condition for list pages: the record (identified by `idColumn`) carries tag `tagId`. */
export function hasTag(entity: TagEntity, idColumn: PgColumn, tagId: string): SQL {
  const link = LINKS[entity];
  // Both sides qualified: unqualified, the outer id would bind to the link table's own columns.
  return sql`exists (select 1 from ${link.table} where ${col(link.table.tagId)} = ${tagId} and ${col(link.key)} = ${col(idColumn)})`;
}

/** The `?tag=` list filter: a tag id, or undefined when absent or malformed. */
export function tagParam(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : undefined;
}
