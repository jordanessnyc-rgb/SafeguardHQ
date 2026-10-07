"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import type { MailboxAction } from "@/worker/mail-ops";

/**
 * Archive / delete / put back a message. The CRM side changes at once (archived_at, raw.trashed);
 * for email the worker then makes the same move in Titan (raw.mailboxPending → Archive/Trash/INBOX)
 * and records the result on the row. Texts and calls only change in the CRM.
 */
async function setBox(activityId: string, box: "inbox" | "archived" | "trashed"): Promise<ActionState> {
  const user = await requireStaff();
  return safeAction(async () => {
    const id = z.uuid().parse(activityId);
    await user.db(async (tx) => {
      const [a] = await tx.select({ id: s.activities.id, type: s.activities.type, raw: s.activities.raw, externalId: s.activities.externalId }).from(s.activities).where(eq(s.activities.id, id));
      if (!a) throw new Error("Message not found.");
      const raw = { ...((a.raw ?? {}) as Record<string, unknown>) };
      delete raw.trashed;
      if (box === "trashed") raw.trashed = new Date().toISOString();
      const isMail = ["EMAIL_IN", "EMAIL_OUT"].includes(a.type) && a.externalId && !a.externalId.includes("@local>");
      if (isMail) {
        const action: MailboxAction = box === "inbox" ? "inbox" : box === "archived" ? "archive" : "trash";
        raw.mailboxPending = { action, at: new Date().toISOString() };
        delete raw.mailbox;
      }
      await tx
        .update(s.activities)
        .set({ archivedAt: box === "inbox" ? null : new Date(), raw })
        .where(eq(s.activities.id, id));
    });
    revalidatePath("/inbox");
    return { ok: true, message: box === "inbox" ? "Moved back to the inbox." : box === "archived" ? "Archived." : "Deleted." };
  });
}

export async function archiveMessage(id: string) {
  return setBox(id, "archived");
}
export async function deleteMessage(id: string) {
  return setBox(id, "trashed");
}
export async function restoreMessage(id: string) {
  return setBox(id, "inbox");
}

/** Archives several at once (the list's checkboxes). */
export async function archiveMany(ids: string[]): Promise<ActionState> {
  const user = await requireStaff();
  return safeAction(async () => {
    const list = z.array(z.uuid()).min(1).max(200).parse(ids);
    const now = new Date();
    await user.db(async (tx) => {
      const rows = await tx.select({ id: s.activities.id, type: s.activities.type, raw: s.activities.raw, externalId: s.activities.externalId }).from(s.activities).where(and(inArray(s.activities.id, list)));
      for (const a of rows) {
        const raw = { ...((a.raw ?? {}) as Record<string, unknown>) };
        delete raw.trashed;
        if (["EMAIL_IN", "EMAIL_OUT"].includes(a.type) && a.externalId && !a.externalId.includes("@local>")) raw.mailboxPending = { action: "archive", at: now.toISOString() };
        await tx.update(s.activities).set({ archivedAt: now, raw }).where(eq(s.activities.id, a.id));
      }
    });
    revalidatePath("/inbox");
    return { ok: true, message: `Archived ${list.length}.` };
  });
}
