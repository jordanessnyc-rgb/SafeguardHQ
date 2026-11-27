"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { markChatRead, markNotificationsRead, postTeamMessage, teamMembers } from "@/lib/team/inbox";

export async function postTeamMessageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    await user.db(async (tx) => postTeamMessage(tx, { body: String(form.get("body") ?? ""), author: { id: user.id, name: user.fullName?.trim() || user.email.split("@")[0] }, members: await teamMembers(tx) }));
    return { ok: true, message: "Sent to the team." };
  });
  revalidatePath("/team-chat");
  return res;
}

/** Removes your own message (the owner can remove any). RLS enforces who may. */
export async function deleteTeamMessageAction(id: string) {
  const user = await requireStaff();
  await user.db((tx) => tx.update(s.teamMessages).set({ deletedAt: new Date() }).where(and(eq(s.teamMessages.id, z.uuid().parse(id)))));
  revalidatePath("/team-chat");
}

export async function markAllReadAction() {
  const user = await requireStaff();
  await user.db(async (tx) => {
    await markNotificationsRead(tx, user.id);
    await markChatRead(tx, user.id);
  });
  revalidatePath("/team-chat");
}
