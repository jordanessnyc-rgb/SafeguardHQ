import { asc, eq } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";

/** Lines, templates, and defaults the compose box needs. */
export async function loadComposeData(tx: Tx) {
  const [lines, templates, [cfg]] = await Promise.all([
    tx.select({ id: s.phoneLines.id, label: s.phoneLines.label }).from(s.phoneLines).orderBy(asc(s.phoneLines.label)),
    tx
      .select({ key: s.messageTemplates.key, name: s.messageTemplates.name, channel: s.messageTemplates.channel })
      .from(s.messageTemplates)
      .where(eq(s.messageTemplates.active, true))
      .orderBy(asc(s.messageTemplates.name)),
    tx.select({ defaultFromEmail: s.settings.defaultFromEmail }).from(s.settings),
  ]);
  return { lines, templates, defaultFromEmail: cfg?.defaultFromEmail ?? "sales@ess-nyc.com" };
}
