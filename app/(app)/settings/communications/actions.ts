"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { checkbox, formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { quoFromEnv } from "@/lib/integrations/quo";
import { toE164 } from "@/lib/phone";

const PATH = "/settings/communications";

const lineSchema = z.object({
  label: z.string().min(1).max(80),
  quoPhoneNumberId: z.string().regex(/^PN\w+$/, "Quo phone number ids start with PN"),
  number: z.string().transform((v, ctx) => toE164(v) ?? (ctx.addIssue({ code: "custom", message: "Invalid phone number" }), v)),
  lineKey: z.string().regex(/^[A-Z0-9_]{2,30}$/, "Use CAPS_WITH_UNDERSCORES, e.g. ESS_MAIN, GAS_PRO, AIRNYC"),
  brand: z.enum(s.brandEnum.enumValues),
  missedCallTextback: checkbox,
});

export async function saveLine(id: string | null, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = lineSchema.parse({ ...formObject(form), missedCallTextback: form.get("missedCallTextback") });
    await user.db((tx) => (id ? tx.update(s.phoneLines).set(v).where(eq(s.phoneLines.id, id)) : tx.insert(s.phoneLines).values(v)));
    return { ok: true, message: "Saved." };
  });
  revalidatePath(PATH);
  return res;
}

export async function deleteLine(id: string) {
  const user = await requireOwner();
  await user.db((tx) => tx.delete(s.phoneLines).where(eq(s.phoneLines.id, id)));
  revalidatePath(PATH);
}

/** Pulls the workspace's numbers from Quo (GET /v1/phone-numbers) and adds any that are missing. */
export async function importQuoNumbers(_prev: ActionState): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const quo = quoFromEnv();
    if (!quo) throw new Error("Set QUO_API_KEY first.");
    const numbers = await quo.listPhoneNumbers();
    let added = 0;
    await user.db(async (tx) => {
      for (const n of numbers) {
        const r = await tx
          .insert(s.phoneLines)
          .values({ quoPhoneNumberId: n.id, number: toE164(n.number) ?? n.number, label: n.name || n.number, lineKey: `LINE_${n.id.slice(-6).toUpperCase()}` })
          .onConflictDoNothing()
          .returning();
        added += r.length;
      }
    });
    return { ok: true, message: `Found ${numbers.length} Quo numbers; added ${added}. Rename them and set line keys below.` };
  });
  revalidatePath(PATH);
  return res;
}

const templateSchema = z.object({
  name: z.string().min(1).max(100),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
  active: checkbox,
});

export async function saveTemplate(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = templateSchema.parse({ ...formObject(form), active: form.get("active") });
    await user.db((tx) => tx.update(s.messageTemplates).set({ ...v, subject: v.subject ?? null }).where(eq(s.messageTemplates.id, id)));
    return { ok: true, message: "Template saved." };
  });
  revalidatePath(PATH);
  return res;
}

const commsSchema = z.object({
  quoSummariesEnabled: checkbox,
  healthAlertPhone: z.string().optional().transform((v) => (v ? (toE164(v) ?? v) : null)),
  healthAlertLineId: optionalUuid,
  defaultFromEmail: z.email(),
  airnycSenderDomains: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
  triageConfidenceThreshold: z.coerce.number().min(0.3).max(0.99).transform((n) => n.toFixed(2)),
  aiVoiceNotes: z.string().max(4000).optional(),
});

export async function saveCommsSettings(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  const res = await safeAction(async () => {
    const v = commsSchema.parse({ ...formObject(form), quoSummariesEnabled: form.get("quoSummariesEnabled") });
    await user.db((tx) => tx.update(s.settings).set({ ...v, healthAlertLineId: v.healthAlertLineId ?? null, aiVoiceNotes: v.aiVoiceNotes ?? null, updatedBy: user.id }).where(eq(s.settings.id, 1)));
    return { ok: true, message: "Saved." };
  });
  revalidatePath(PATH);
  return res;
}
