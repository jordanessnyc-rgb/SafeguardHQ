"use server";

import { z } from "zod";
import { requireOwner } from "@/lib/auth/session";
import { quoFromEnv } from "@/lib/integrations/quo";
import { loadCallDetails, type QuoCallDetails } from "@/lib/comms/quo-call-details";

export async function fetchQuoCallDetails(activityId: string): Promise<{ details?: QuoCallDetails; error?: string }> {
  const user = await requireOwner();
  if (!z.uuid().safeParse(activityId).success) return { error: "Invalid call." };
  const quo = quoFromEnv();
  if (!quo) return { error: "Quo isn't connected. Configure QUO_API_KEY on the server." };
  try { return { details: await loadCallDetails(user, activityId, quo) }; }
  catch { return { error: "This call isn't available here. Protected AIRnyc calls must be reviewed in Quo." }; }
}
