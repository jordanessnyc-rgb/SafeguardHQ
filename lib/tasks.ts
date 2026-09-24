import { eq } from "drizzle-orm";
import { schema as s, type Db } from "@/lib/db";

async function ownerIds(db: Db) {
  const rows = await db.select({ id: s.profiles.userId }).from(s.profiles).where(eq(s.profiles.role, "OWNER"));
  return rows.length ? rows.map((r) => r.id) : [null];
}

/** A SYSTEM_RULE task for each owner (due tomorrow unless given). Returns the new task ids. */
export async function ownerTask(
  db: Db,
  t: { title: string; description?: string; jobId?: string | null; contactId?: string | null; propertyId?: string | null; dueAt?: Date },
): Promise<string[]> {
  const owners = await ownerIds(db);
  const rows = await db
    .insert(s.tasks)
    .values(owners.map((assignee) => ({ ...t, assignee, source: "SYSTEM_RULE" as const, dueAt: t.dueAt ?? new Date(Date.now() + 24 * 3600_000) })))
    .returning({ id: s.tasks.id });
  return rows.map((r) => r.id);
}
