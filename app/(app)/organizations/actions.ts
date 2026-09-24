"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { formObject, safeAction, type ActionState } from "@/lib/actions";
import { toE164 } from "@/lib/phone";

const orgSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  type: z.enum(s.orgTypeEnum.enumValues),
  brand: z.enum(s.brandEnum.enumValues),
  website: z.string().max(300).optional(),
  phone: z.string().optional().transform((v) => (v ? (toE164(v) ?? v) : undefined)),
  email: z.email().optional(),
  notes: z.string().max(5000).optional(),
});

export async function createOrganization(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  let id: string | undefined;
  const res = await safeAction(async () => {
    const input = orgSchema.parse(formObject(form));
    [{ id }] = await user.db((tx) => tx.insert(s.organizations).values(input).returning({ id: s.organizations.id }));
  });
  if (res.error || !id) return res;
  redirect(`/organizations/${id}`);
}

export async function updateOrganization(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = orgSchema.parse(formObject(form));
    await user.db((tx) =>
      tx
        .update(s.organizations)
        .set({ ...input, website: input.website ?? null, phone: input.phone ?? null, email: input.email ?? null, notes: input.notes ?? null })
        .where(eq(s.organizations.id, id)),
    );
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/organizations/${id}`);
  return res;
}

export async function archiveOrganization(id: string) {
  const user = await requireStaff();
  await user.db((tx) => tx.update(s.organizations).set({ archivedAt: new Date() }).where(eq(s.organizations.id, id)));
  redirect("/organizations");
}
