"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { formObject, optionalUuid, safeAction, type ActionState } from "@/lib/actions";
import { fromNyInput } from "@/lib/time";

const taskSchema = z.object({
  title: z.string().min(1, "Title is required").max(300),
  description: z.string().max(5000).optional(),
  dueAt: z
    .string()
    .optional()
    .transform((v) => (v ? fromNyInput(v) : undefined)),
  assignee: optionalUuid,
  jobId: optionalUuid,
  contactId: optionalUuid,
  propertyId: optionalUuid,
  airnycCaseId: optionalUuid,
  bidId: optionalUuid,
});

export async function createTask(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const input = taskSchema.parse(formObject(form));
    await user.db((tx) => tx.insert(s.tasks).values({ ...input, assignee: input.assignee ?? user.id, source: "MANUAL" }));
    return { ok: true };
  });
  const back = formObject(form).revalidate;
  if (back?.startsWith("/")) revalidatePath(back);
  revalidatePath("/tasks");
  return res;
}

export async function setTaskStatus(id: string, status: "OPEN" | "DONE" | "CANCELED", revalidate?: string) {
  const user = await requireStaff();
  await user.db((tx) =>
    tx
      .update(s.tasks)
      .set({ status, completedAt: status === "DONE" ? new Date() : null })
      .where(eq(s.tasks.id, id)),
  );
  if (revalidate?.startsWith("/")) revalidatePath(revalidate);
  revalidatePath("/tasks");
}
