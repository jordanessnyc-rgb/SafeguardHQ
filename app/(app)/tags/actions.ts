"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner, requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { addTag, cleanTagName, findOrCreateTag, isTagColor, isTagEntity, removeTag, type TagEntity } from "@/lib/tags";

const PATHS: Record<TagEntity, (id: string) => string> = {
  contact: (id) => `/contacts/${id}`,
  organization: (id) => `/organizations/${id}`,
  job: (id) => `/jobs/${id}`,
};
const LIST_PATHS: Record<TagEntity, string> = { contact: "/contacts", organization: "/organizations", job: "/jobs" };

function refresh(entity: TagEntity, id: string) {
  revalidatePath(PATHS[entity](id));
  revalidatePath(LIST_PATHS[entity]);
}

/** Adds a tag (by name: an existing one is reused, a new one is created) to a contact, company or job. */
export async function addTagAction(entity: TagEntity, recordId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    if (!isTagEntity(entity)) throw new Error("Unknown record type.");
    z.uuid().parse(recordId);
    const name = cleanTagName(form.get("name"));
    if (!name) return { error: "Type a tag name (up to 40 characters)." };
    const color = form.get("color");
    const added = await user.db(async (tx) => {
      const tag = await findOrCreateTag(tx, name, isTagColor(color) ? color : "gray");
      return { tag, isNew: await addTag(tx, entity, recordId, tag.id) };
    });
    return { ok: true, message: added.isNew ? `Tagged “${added.tag.name}”.` : `Already tagged “${added.tag.name}”.` };
  });
  refresh(entity, recordId);
  return res;
}

export async function removeTagAction(entity: TagEntity, recordId: string, tagId: string) {
  const user = await requireStaff();
  if (!isTagEntity(entity)) throw new Error("Unknown record type.");
  await user.db((tx) => removeTag(tx, entity, z.uuid().parse(recordId), z.uuid().parse(tagId)));
  refresh(entity, recordId);
}

const tagSchema = z.object({
  name: z.string().transform((v, ctx) => cleanTagName(v) ?? (ctx.addIssue({ code: "custom", message: "Tag names are 1–40 characters." }), v)),
  color: z.string().refine(isTagColor, "Pick a colour."),
  description: z.string().max(200).optional(),
});

/** Settings → Tags: rename / recolour / describe a tag (staff). */
export async function saveTagAction(tagId: string | null, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = tagSchema.parse({ name: form.get("name") ?? "", color: form.get("color") ?? "gray", description: String(form.get("description") ?? "").trim() || undefined });
    await user.db(async (tx) => {
      const [clash] = await tx
        .select({ id: s.tags.id })
        .from(s.tags)
        .where(and(eq(sql`lower(${s.tags.name})`, v.name.toLowerCase()), isNull(s.tags.archivedAt), tagId ? ne(s.tags.id, tagId) : undefined));
      if (clash) throw new Error(`There's already a tag called “${v.name}”.`);
      const values = { name: v.name, color: v.color as (typeof s.tags.$inferInsert)["color"], description: v.description ?? null };
      if (tagId) await tx.update(s.tags).set(values).where(eq(s.tags.id, z.uuid().parse(tagId)));
      else await tx.insert(s.tags).values(values);
    });
    return { ok: true, message: tagId ? "Tag saved." : "Tag created." };
  });
  revalidatePath("/settings/tags");
  return res;
}

/** Deletes a tag everywhere it's used. OWNER only (RLS enforces it too). */
export async function deleteTagAction(tagId: string) {
  const user = await requireOwner();
  await user.db((tx) => tx.delete(s.tags).where(eq(s.tags.id, z.uuid().parse(tagId))));
  revalidatePath("/settings/tags");
  for (const p of Object.values(LIST_PATHS)) revalidatePath(p);
}
