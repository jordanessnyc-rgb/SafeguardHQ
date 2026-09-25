"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { siteOrigin } from "@/lib/site";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { formObject, safeAction, type ActionState } from "@/lib/actions";
import { isSettingsSection, parseSettingsSection } from "@/lib/settings/form";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Saves one Settings section (hidden `section` field). Only that section's columns are written. */
export async function saveSettings(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const section = form.get("section");
    if (!isSettingsSection(section)) throw new Error("Unknown settings section.");
    const update = parseSettingsSection(section, form);
    await user.db((tx) => tx.update(s.settings).set({ ...update, updatedBy: user.id }).where(eq(s.settings.id, 1)));
    revalidatePath("/settings", "layout");
    return { ok: true, message: "Saved." };
  });
}

export async function saveStaleDays(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const updates = [...form.entries()]
      .filter(([k]) => k.startsWith("stale:"))
      .map(([k, v]) => {
        const [, pipelineKey, key] = k.split(":");
        const n = String(v).trim();
        return { pipelineKey, key, days: n === "" ? null : z.coerce.number().int().min(0).max(365).parse(n) };
      });
    await user.db(async (tx) => {
      for (const u of updates) {
        await tx
          .update(s.pipelineStages)
          .set({ staleAfterDays: u.days })
          .where(and(eq(s.pipelineStages.pipelineKey, u.pipelineKey), eq(s.pipelineStages.key, u.key)));
      }
    });
    revalidatePath("/settings");
    return { ok: true, message: "Pipeline timings saved." };
  });
}

const role = z.enum(["OWNER", "VA", "FIELD", "SUB"]);

export async function inviteUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const input = z.object({ email: z.email(), fullName: z.string().max(200).optional(), role, orgId: z.uuid().optional() }).parse(formObject(form));
    if (input.role === "SUB" && !input.orgId) throw new Error("Pick the subcontractor's organization.");
    const h = await headers();
    const origin = siteOrigin(h);
    const { data, error } = await supabaseAdmin().auth.admin.inviteUserByEmail(input.email, {
      redirectTo: `${origin}/auth/confirm`,
      data: { full_name: input.fullName },
    });
    if (error || !data.user) throw new Error(error?.message ?? "Invite failed");
    // The auth.users trigger created the profile with no role; assign it now (OWNER-only via RLS).
    await user.db((tx) =>
      tx.update(s.profiles).set({ role: input.role, fullName: input.fullName ?? null, orgId: input.role === "SUB" ? input.orgId! : null }).where(eq(s.profiles.userId, data.user.id)),
    );
    revalidatePath("/settings");
    return { ok: true, message: `Invite sent to ${input.email}.` };
  });
}

export async function setUserRole(userId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const value = form.get("role") ? role.parse(form.get("role")) : null;
    const orgId = form.get("orgId") ? z.uuid().parse(form.get("orgId")) : null;
    if (value === "SUB" && !orgId) throw new Error("Pick the subcontractor's organization for a Sub.");
    await user.db(async (tx) => {
      if (value !== "OWNER") {
        const [{ owners }] = await tx
          .select({ owners: sql<number>`count(*)::int` })
          .from(s.profiles)
          .where(and(eq(s.profiles.role, "OWNER"), ne(s.profiles.userId, userId)));
        if (owners === 0) throw new Error("There must be at least one owner.");
      }
      await tx.update(s.profiles).set({ role: value, orgId: value === "SUB" ? orgId : null }).where(eq(s.profiles.userId, userId));
    });
    revalidatePath("/settings");
    return { ok: true, message: "Role updated." };
  });
}

export async function addChecklistItem(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const input = z
      .object({ stage: z.string().min(1), label: z.string().min(1).max(200), fileNamePattern: z.string().max(200).optional(), position: z.coerce.number().int().default(0) })
      .parse(formObject(form));
    await user.db((tx) => tx.insert(s.airnycChecklistItems).values(input));
    revalidatePath("/settings");
    return { ok: true };
  });
}

export async function setChecklistItemActive(id: string, active: boolean) {
  const user = await requireOwner();
  await user.db((tx) => tx.update(s.airnycChecklistItems).set({ active }).where(eq(s.airnycChecklistItems.id, id)));
  revalidatePath("/settings");
}
