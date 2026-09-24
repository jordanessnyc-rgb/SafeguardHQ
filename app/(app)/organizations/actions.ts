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
  holdReportUntilPaid: z
    .enum(["", "true", "false"])
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : null)),
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

const subSchema = z.object({
  trades: z.string().optional().transform((v) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)),
  licenseNumbers: z
    .string()
    .optional()
    .transform((v, ctx) =>
      Object.fromEntries(
        (v ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf(":");
            if (i < 1) ctx.addIssue({ code: "custom", message: `License line "${l}" should look like: EPA firm: NAT-12345` });
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
          }),
      ),
    ),
  insuranceExpires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(2000).optional(),
});

/** Sub details — no rates here (those live in sub_costs, OWNER only). Staff can keep COIs current. */
export async function saveSubProfile(orgId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = subSchema.parse(formObject(form));
    const values = { trades: v.trades, licenseNumbers: v.licenseNumbers, insuranceExpires: v.insuranceExpires ?? null, notes: v.notes ?? null };
    await user.db((tx) => tx.insert(s.subProfiles).values({ orgId, ...values }).onConflictDoUpdate({ target: s.subProfiles.orgId, set: values }));
    return { ok: true, message: "Saved." };
  });
  revalidatePath(`/organizations/${orgId}`);
  return res;
}
