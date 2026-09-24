"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { checkbox, formObject, safeAction, type ActionState } from "@/lib/actions";

const PATH = "/compliance";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date");

const ruleSchema = z.object({
  serviceCode: z.enum(s.serviceCodeEnum.enumValues),
  cycleMonths: z.coerce.number().int().min(1).max(240).optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(730),
  notes: z.string().max(1000).optional(),
  active: checkbox,
});

/** Jordan's compliance cycle for one service (SPEC §6.6). Blank months → set each job's date by hand. */
export async function saveRule(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = ruleSchema.parse({ ...formObject(form), active: form.get("active") });
    const values = { cycleMonths: v.cycleMonths ?? null, leadTimeDays: v.leadTimeDays, notes: v.notes ?? null, active: v.active, archivedAt: null };
    await user.db((tx) => tx.insert(s.complianceRules).values({ serviceCode: v.serviceCode, ...values }).onConflictDoUpdate({ target: s.complianceRules.serviceCode, set: values }));
    return { ok: true, message: "Rule saved." };
  });
  revalidatePath(PATH);
  return res;
}

const credSchema = z.object({
  name: z.string().min(1).max(200),
  number: z.string().max(100).optional(),
  issuer: z.string().max(200).optional(),
  expiresAt: isoDate.optional(),
  notes: z.string().max(1000).optional(),
});

export async function saveCredential(id: string | null, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = credSchema.parse(formObject(form));
    const values = { name: v.name, number: v.number ?? null, issuer: v.issuer ?? null, expiresAt: v.expiresAt ?? null, notes: v.notes ?? null };
    await user.db((tx) => (id ? tx.update(s.credentials).set(values).where(eq(s.credentials.id, id)) : tx.insert(s.credentials).values(values)));
    return { ok: true, message: "Saved." };
  });
  revalidatePath(PATH);
  return res;
}

export async function archiveCredential(id: string) {
  const user = await requireOwner();
  await user.db((tx) => tx.update(s.credentials).set({ archivedAt: new Date() }).where(eq(s.credentials.id, id)));
  revalidatePath(PATH);
}
