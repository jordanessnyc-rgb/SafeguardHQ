"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { addInternalNote, assignConversation, teamMembers } from "@/lib/team/inbox";
import { markConversationRead, toggleStar } from "@/lib/team/conversations";
import { composeMessage } from "@/app/(app)/comms/actions";

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

// --- Conversation view -------------------------------------------------------------------------

const keySchema = z.string().min(3).max(400).regex(/^(c|a|m):/);

/** Star / unstar a conversation (personal). */
export async function toggleStarAction(key: string) {
  const user = await requireStaff();
  await user.db((tx) => toggleStar(tx, user.id, keySchema.parse(key)));
  revalidatePath("/inbox");
}

/** Bulk "Mark as read" from the conversation list (checked rows). */
export async function markReadAction(form: FormData) {
  const user = await requireStaff();
  const keys = z.array(keySchema).max(500).parse(form.getAll("key").map(String));
  await user.db((tx) => markConversationRead(tx, user.id, keys));
  revalidatePath("/inbox");
}

/**
 * The conversation's message bar: SMS and Email go through the normal compose action (a person is
 * sending, so it's approved and sent at once, same as "Send now"); Internal comment adds a note.
 */
export async function sendInConversationAction(lastActivityId: string, prev: ActionState, form: FormData): Promise<ActionState> {
  if (form.get("channel") === "INTERNAL") {
    const note = new FormData();
    note.set("body", String(form.get("body") ?? ""));
    return addNoteAction(lastActivityId, prev, note);
  }
  form.set("intent", "send");
  return composeMessage(prev, form);
}
