"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { checkbox, formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { toE164 } from "@/lib/phone";

const list = (v?: string) => (v ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

const contactSchema = z
  .object({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    orgId: optionalUuid,
    title: z.string().max(100).optional(),
    emails: z.string().optional().transform(list).pipe(z.array(z.email())),
    phones: z
      .string()
      .optional()
      .transform((v, ctx) =>
        list(v).map((p) => {
          const e164 = toE164(p);
          if (!e164) ctx.addIssue({ code: "custom", message: `"${p}" isn't a valid phone number` });
          return e164 ?? p;
        }),
      ),
    preferredChannel: z.enum(s.preferredChannelEnum.enumValues).optional(),
    source: z.enum(s.contactSourceEnum.enumValues),
    brand: z.enum(s.brandEnum.enumValues),
    doNotContact: checkbox,
    notes: z.string().max(5000).optional(),
  })
  .refine((v) => v.firstName || v.lastName, "Enter a first or last name");

const parse = (form: FormData) => contactSchema.parse({ ...formObject(form), doNotContact: form.get("doNotContact") });

export async function createContact(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  let id: string | undefined;
  const res = await safeAction(async () => {
    const input = parse(form);
    [{ id }] = await user.db((tx) => tx.insert(s.contacts).values(input).returning({ id: s.contacts.id }));
  });
  if (res.error || !id) return res;
  redirect(`/contacts/${id}`);
}

export async function updateContact(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = parse(form);
    await user.db((tx) =>
      tx
        .update(s.contacts)
        .set({
          ...input,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          orgId: input.orgId ?? null,
          title: input.title ?? null,
          preferredChannel: input.preferredChannel ?? null,
          notes: input.notes ?? null,
        })
        .where(eq(s.contacts.id, id)),
    );
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/contacts/${id}`);
  return res;
}

export async function archiveContact(id: string) {
  const user = await requireStaff();
  await user.db((tx) => tx.update(s.contacts).set({ archivedAt: new Date() }).where(eq(s.contacts.id, id)));
  redirect("/contacts");
}
