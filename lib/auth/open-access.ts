import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s, type Db } from "@/lib/db";

/** Resolves only the existing owner profile; never creates accounts or grants database roles. */
export async function openAccessOwner(db: Db, userId = process.env.CRM_OPEN_ACCESS_USER_ID) {
  if (userId && !z.uuid().safeParse(userId).success) throw new Error("CRM_OPEN_ACCESS_USER_ID must be an existing owner's UUID.");
  const profiles = await db.select().from(s.profiles).where(
    userId ? and(eq(s.profiles.role, "OWNER"), eq(s.profiles.userId, userId)) : eq(s.profiles.role, "OWNER"),
  ).limit(2);
  if (profiles.length !== 1) throw new Error("Open access requires exactly one ESS owner. Set CRM_OPEN_ACCESS_USER_ID to select the existing owner.");
  return profiles[0];
}
