"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { stagesFor } from "@/lib/pipeline/config";
import { stageAfterScheduling } from "@/lib/schedule/rules";
import { fromNyInput } from "@/lib/time";

const input = z.object({
  jobId: z.uuid(),
  // New York wall-clock "YYYY-MM-DDTHH:mm", or null to take the job off the schedule.
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable(),
  durationMinutes: z.number().int().min(15).max(720).nullable().optional(),
  // undefined = leave as is; null = unassign.
  assignedTo: z.uuid().nullable().optional(),
});

/**
 * Put a job on the schedule, move it, or take it off. The Titan calendar picks the change up on the
 * worker's next pass (every 5 minutes); nothing is sent to the client.
 */
export async function scheduleJob(raw: z.input<typeof input>): Promise<ActionState & { stage?: string }> {
  const user = await requireStaff();
  let movedTo: string | undefined;
  const res = await safeAction(async () => {
    const v = input.parse(raw);
    await user.db(async (tx) => {
      const [job] = await tx.select({ stage: s.jobs.stage, pipelineKey: s.jobs.pipelineKey, scheduledAt: s.jobs.scheduledAt }).from(s.jobs).where(eq(s.jobs.id, v.jobId));
      if (!job) throw new Error("Job not found.");
      const next = v.start && !job.scheduledAt ? stageAfterScheduling(await stagesFor(tx, job.pipelineKey), job.stage) : null;
      if (next) movedTo = next;
      await tx
        .update(s.jobs)
        .set({
          scheduledAt: v.start ? fromNyInput(v.start) : null,
          ...(v.durationMinutes !== undefined ? { durationMinutes: v.durationMinutes } : {}),
          ...(v.assignedTo !== undefined ? { assignedTo: v.assignedTo } : {}),
          ...(next ? { stage: next } : {}),
        })
        .where(eq(s.jobs.id, v.jobId));
    });
  });
  revalidatePath("/schedule");
  revalidatePath(`/jobs/${raw.jobId}`);
  revalidatePath("/");
  return res.error ? res : { ok: true, stage: movedTo };
}
