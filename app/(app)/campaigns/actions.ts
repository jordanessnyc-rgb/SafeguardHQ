"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner, requireStaff } from "@/lib/auth/session";
import { formObject, safeAction, type ActionState } from "@/lib/actions";

const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.enum(s.brandEnum.enumValues),
  channel: z.enum(s.campaignChannelEnum.enumValues),
  sentCount: z.coerce.number().int().min(0).max(10_000_000).optional(),
  qrSlug: z
    .string()
    .regex(/^[a-z0-9-]{2,60}$/, "QR code name: lowercase letters, numbers and dashes")
    .optional(),
  quoNumber: z.string().optional(),
  landingUrl: z.url().optional(),
  notes: z.string().max(5000).optional(),
});

export async function saveCampaign(id: string | null, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = campaignSchema.parse(formObject(form));
    const values = {
      name: v.name,
      brand: v.brand,
      channel: v.channel,
      sentCount: v.sentCount ?? null,
      notes: v.notes ?? null,
      tracking: { ...(v.qrSlug ? { qrSlug: v.qrSlug } : {}), ...(v.quoNumber ? { quoNumber: v.quoNumber } : {}), ...(v.landingUrl ? { landingUrl: v.landingUrl } : {}) },
    };
    await user.db((tx) => (id ? tx.update(s.campaigns).set(values).where(eq(s.campaigns.id, id)) : tx.insert(s.campaigns).values(values)));
    return { ok: true, message: "Saved." };
  });
  revalidatePath("/campaigns");
  return res;
}

/** Campaign spend is financial → OWNER only (campaign_costs). */
export async function saveCampaignCost(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const cost = z
      .string()
      .transform((v) => v.replace(/[$,\s]/g, ""))
      .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "Enter a dollar amount")
      .parse(form.get("cost") ?? "");
    await user.db((tx) => tx.insert(s.campaignCosts).values({ campaignId: id, cost }).onConflictDoUpdate({ target: s.campaignCosts.campaignId, set: { cost, updatedAt: new Date() } }));
    return { ok: true, message: "Cost saved." };
  });
  revalidatePath("/campaigns");
  return res;
}
