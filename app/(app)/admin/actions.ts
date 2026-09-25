"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/session";
import { dismissDeadJobs, retryDeadJobs, webBoss } from "@/lib/admin/dead-letter";

export async function retryJob(id: string): Promise<void> {
  await requireOwner();
  await retryDeadJobs(await webBoss(), [id]);
  revalidatePath("/admin");
}

export async function dismissJob(id: string): Promise<void> {
  await requireOwner();
  await dismissDeadJobs(await webBoss(), [id]);
  revalidatePath("/admin");
}
