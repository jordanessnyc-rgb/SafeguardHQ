"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { checkbox, formObject, safeAction, type ActionState } from "@/lib/actions";

const dollars = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/[$,\s]/g, "") : undefined))
    .refine((v) => v === undefined || (/^\d+(\.\d{1,4})?$/.test(v) && Number(v) <= max), "Enter a dollar amount");

const ruleSchema = z.object({
  serviceCode: z.enum(s.serviceCodeEnum.enumValues),
  baseAmount: dollars(1_000_000).refine((v) => v !== undefined, "Base price is required"),
  includedSqft: z.coerce.number().int().min(0).max(10_000_000).default(0),
  perSqft: dollars(1000),
  includedSamples: z.coerce.number().int().min(0).max(1000).default(0),
  perSample: dollars(100_000),
  minimumAmount: dollars(1_000_000),
  defaultScope: z.string().max(5000).optional(),
  active: checkbox,
});

/** Jordan's price list (SPEC §10). OWNER only, enforced by RLS on pricing_rules as well. */
export async function savePricingRule(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = ruleSchema.parse({ ...formObject(form), active: form.get("active") });
    const values = {
      baseAmount: v.baseAmount!,
      includedSqft: v.includedSqft,
      perSqft: v.perSqft ?? null,
      includedSamples: v.includedSamples,
      perSample: v.perSample ?? null,
      minimumAmount: v.minimumAmount ?? null,
      defaultScope: v.defaultScope ?? null,
      active: v.active,
    };
    await user.db((tx) => tx.insert(s.pricingRules).values({ serviceCode: v.serviceCode, ...values }).onConflictDoUpdate({ target: s.pricingRules.serviceCode, set: values }));
    return { ok: true, message: "Saved." };
  });
  revalidatePath("/settings/pricing");
  return res;
}
