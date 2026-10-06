"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { passwordProblem } from "@/lib/auth/password";
import { formObject, safeAction, type ActionState } from "@/lib/actions";
import { isSettingsSection, parseSettingsSection } from "@/lib/settings/form";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { adminDb } from "@/lib/db";
import { graphFromEnv } from "@/lib/integrations/microsoft-graph";
import { recordSync, syncTracker } from "@/lib/airnyc/graph-sync";
import { TRACKER_FIELDS } from "@/lib/airnyc/tracker";

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

/**
 * Adds a teammate with a starting password the owner gives them (no invite email). They can change
 * it after signing in (Account → Password).
 */
export async function addUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const input = z
      .object({ email: z.email(), fullName: z.string().max(200).optional(), role, orgId: z.uuid().optional(), password: z.string() })
      .parse(formObject(form));
    if (input.role === "SUB" && !input.orgId) throw new Error("Pick the subcontractor's organization.");
    const problem = passwordProblem(input.password);
    if (problem) throw new Error(problem);
    const email = input.email.toLowerCase();
    const { data, error } = await supabaseAdmin().auth.admin.createUser({ email, password: input.password, email_confirm: true, user_metadata: { full_name: input.fullName } });
    if (error || !data.user) throw new Error(/already been registered|already exists/i.test(error?.message ?? "") ? "Someone with that email already has an account." : (error?.message ?? "Couldn't add the user."));
    // The auth.users trigger created the profile with no role; assign it now (OWNER-only via RLS).
    await user.db(async (tx) => {
      await tx.update(s.profiles).set({ role: input.role, fullName: input.fullName ?? null, orgId: input.role === "SUB" ? input.orgId! : null }).where(eq(s.profiles.userId, data.user.id));
      await tx.insert(s.auditLog).values({ actor: user.id, action: "INSERT", entity: "auth.users", entityId: data.user.id, detail: { email, role: input.role, password: "set by owner" } });
    });
    revalidatePath("/settings");
    return { ok: true, message: `${email} can now sign in with the password you chose.` };
  });
}

/** Owner sets (or resets) a teammate's password — e.g. a VA who forgot theirs. */
export async function setUserPassword(userId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const id = z.uuid().parse(userId);
    const password = String(form.get("password") ?? "");
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const { error } = await supabaseAdmin().auth.admin.updateUserById(id, { password });
    if (error) throw new Error(error.message);
    await user.db((tx) => tx.insert(s.auditLog).values({ actor: user.id, action: "UPDATE", entity: "auth.users", entityId: id, detail: { password: "set by owner" } }));
    return { ok: true, message: "Password set. Tell them the new password; they can change it after signing in." };
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

// ---------------------------------------------------------------------------------------------
// AIRnyc over Microsoft Graph (SPEC §7.4 mode 4)
// ---------------------------------------------------------------------------------------------

/** Saves which tracker column feeds which case field (Settings → AIRnyc). */
export async function saveTrackerColumns(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const map: Record<string, string> = {};
    for (const field of Object.keys(TRACKER_FIELDS)) {
      const v = String(form.get(`col:${field}`) ?? "").trim();
      if (v) map[field] = v;
    }
    if (!map.caseId) throw new Error("Pick the column that holds the case ID.");
    await user.db((tx) => tx.update(s.settings).set({ airnycTrackerColumns: map, updatedBy: user.id }).where(eq(s.settings.id, 1)));
    revalidatePath("/settings", "layout");
    return { ok: true, message: "Column mapping saved." };
  });
}

/** Runs the tracker sync right now (the worker also runs it every 15 minutes). */
export async function syncAirnycNow(_prev: ActionState): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const graph = graphFromEnv();
    if (!graph) throw new Error("The server doesn't have the Microsoft connection set up (MS_GRAPH_* in the host's secrets).");
    const [cfg] = await user.db((tx) => tx.select().from(s.settings));
    if (!cfg) throw new Error("Settings not found.");
    try {
      const r = await syncTracker(adminDb(), graph, cfg);
      await recordSync(adminDb(), r);
      revalidatePath("/settings", "layout");
      revalidatePath("/airnyc");
      return { ok: true, message: `${r.rows} tracker rows: ${r.created} new case${r.created === 1 ? "" : "s"}, ${r.updated} updated, ${r.foldersLinked} folder${r.foldersLinked === 1 ? "" : "s"} linked${r.skipped ? `, ${r.skipped} rows without a case ID skipped` : ""}.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}` };
    } catch (e) {
      await recordSync(adminDb(), e as Error);
      revalidatePath("/settings", "layout");
      throw e;
    }
  });
}
