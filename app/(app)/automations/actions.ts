"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { definitionSchema } from "@/lib/automation/definition";

const formSchema = z.object({
  name: z.string().trim().min(1, "Give the workflow a name.").max(100),
  description: z.string().trim().max(500).optional(),
});

/**
 * Creates or updates a workflow (owner only; RLS enforces it too). The trigger/conditions/steps
 * arrive as one JSON field from the editor and are validated with the same schema the worker uses.
 */
export async function saveWorkflow(id: string | null, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  let newId: string | null = null;
  const res = await safeAction(async () => {
    const f = formSchema.parse({ name: form.get("name") ?? "", description: String(form.get("description") ?? "") || undefined });
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("definition") ?? ""));
    } catch {
      return { error: "The workflow couldn't be read. Reload the page and try again." };
    }
    const parsed = definitionSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
    const values = { name: f.name, description: f.description ?? null, ...parsed.data };
    await user.db(async (tx) => {
      if (id) await tx.update(s.workflows).set(values).where(eq(s.workflows.id, z.uuid().parse(id)));
      else newId = (await tx.insert(s.workflows).values(values).returning({ id: s.workflows.id }))[0].id;
    });
    return { ok: true, message: id ? "Workflow saved." : "Workflow created. It's off until you switch it on." };
  });
  revalidatePath("/automations");
  if (newId) redirect(`/automations/${newId}`);
  if (id) revalidatePath(`/automations/${id}`);
  return res;
}

/**
 * Switches a workflow on or off. Switching on restarts the clock: only events from now on start runs,
 * so it never acts on history (or on what happened while it was off). Switching off stops its runs
 * the next time the worker looks at them.
 */
export async function setWorkflowActive(id: string, active: boolean) {
  const user = await requireOwner();
  await user.db((tx) => tx.update(s.workflows).set({ active, ...(active ? { activatedAt: new Date() } : {}) }).where(eq(s.workflows.id, z.uuid().parse(id))));
  revalidatePath("/automations");
  revalidatePath(`/automations/${id}`);
}

export async function deleteWorkflow(id: string) {
  const user = await requireOwner();
  await user.db((tx) => tx.delete(s.workflows).where(eq(s.workflows.id, z.uuid().parse(id))));
  revalidatePath("/automations");
  redirect("/automations");
}
