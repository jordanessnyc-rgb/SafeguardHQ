"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { addInternalNote, assignConversation, teamMembers } from "@/lib/team/inbox";

const actorName = (u: { fullName: string | null; email: string }) => u.fullName?.trim() || u.email.split("@")[0];

/** Assigns the message's conversation to a team member ("" = unassign). */
export async function assignConversationAction(activityId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const raw = String(form.get("assignee") ?? "");
    const assignee = raw ? z.uuid().parse(raw) : null;
    await user.db(async (tx) => {
      const [a] = await tx.select().from(s.activities).where(eq(s.activities.id, z.uuid().parse(activityId)));
      if (!a) throw new Error("That message no longer exists.");
      const members = await teamMembers(tx);
      if (assignee && !members.some((m) => m.id === assignee)) throw new Error("Pick someone on the team.");
      await assignConversation(tx, { activity: a, assignee, actor: { id: user.id, name: actorName(user) } });
    });
    return { ok: true, message: assignee ? "Assigned." : "Unassigned." };
  });
  revalidatePath("/inbox");
  revalidatePath("/team-chat");
  return res;
}

/** Adds an internal note (never sent) to the message's conversation; @mentions notify teammates. */
export async function addNoteAction(activityId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const r = await user.db(async (tx) => {
      const [a] = await tx.select().from(s.activities).where(eq(s.activities.id, z.uuid().parse(activityId)));
      if (!a) throw new Error("That message no longer exists.");
      return addInternalNote(tx, { activity: a, body: String(form.get("body") ?? ""), author: { id: user.id, name: actorName(user) }, members: await teamMembers(tx) });
    });
    return { ok: true, message: r.mentions.length ? `Note added. ${r.mentions.length} teammate${r.mentions.length === 1 ? "" : "s"} notified.` : "Note added." };
  });
  revalidatePath("/inbox");
  return res;
}
