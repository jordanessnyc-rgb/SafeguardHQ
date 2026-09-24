/**
 * Credential alerts (SPEC §10): 60 / 30 / 7 days before an ESS license or a sub's COI expires, and
 * once more when it has expired. Each (subject, expiry date, threshold) fires once — a renewal (new
 * date) starts the cycle again. When several thresholds are already crossed (e.g. a date entered
 * with 5 days left) only the tightest one raises a task.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { ownerTask } from "@/lib/tasks";
import { nyDate } from "@/lib/time";

export const EXPIRY_THRESHOLDS = [60, 30, 7, 0] as const;

export type Expiring = { type: "CREDENTIAL" | "SUB_COI"; id: string; name: string; expiresOn: string; daysLeft: number; href: string };

export function daysUntil(isoDate: string, now: Date): number {
  return Math.round((Date.parse(`${isoDate}T12:00:00Z`) - Date.parse(`${nyDate(now)}T12:00:00Z`)) / 86_400_000);
}

/** Everything expiring within `withinDays` (and anything already expired), soonest first. */
export async function expiringItems(conn: Db | Tx, now = new Date(), withinDays = 60): Promise<Expiring[]> {
  const creds = await conn.select().from(s.credentials).where(and(isNull(s.credentials.archivedAt), isNotNull(s.credentials.expiresAt)));
  const subs = await conn
    .select({ orgId: s.subProfiles.orgId, name: s.organizations.name, expires: s.subProfiles.insuranceExpires })
    .from(s.subProfiles)
    .innerJoin(s.organizations, eq(s.organizations.id, s.subProfiles.orgId))
    .where(and(isNull(s.organizations.archivedAt), isNotNull(s.subProfiles.insuranceExpires)));
  const items: Expiring[] = [
    ...creds.map((c) => ({ type: "CREDENTIAL" as const, id: c.id, name: `${c.name}${c.number ? ` #${c.number}` : ""}`, expiresOn: c.expiresAt!, daysLeft: daysUntil(c.expiresAt!, now), href: "/compliance#licenses" })),
    ...subs.map((x) => ({ type: "SUB_COI" as const, id: x.orgId, name: `${x.name} — insurance (COI)`, expiresOn: x.expires!, daysLeft: daysUntil(x.expires!, now), href: `/organizations/${x.orgId}` })),
  ];
  return items.filter((i) => i.daysLeft <= withinDays).sort((a, b) => a.daysLeft - b.daysLeft);
}

export async function raiseExpiryAlerts(db: Db, now = new Date()): Promise<{ name: string; threshold: number }[]> {
  const raised: { name: string; threshold: number }[] = [];
  for (const item of await expiringItems(db, now, EXPIRY_THRESHOLDS[0])) {
    const crossed = EXPIRY_THRESHOLDS.filter((t) => item.daysLeft <= t);
    const tightest = crossed[crossed.length - 1];
    const inserted = await db
      .insert(s.expiryAlerts)
      .values(crossed.map((t) => ({ subjectType: item.type, subjectId: item.id, expiresOn: item.expiresOn, thresholdDays: t })))
      .onConflictDoNothing()
      .returning();
    const mine = inserted.find((r) => r.thresholdDays === tightest);
    if (!mine) continue; // already alerted at this threshold
    const when = item.daysLeft < 0 ? `expired ${-item.daysLeft} days ago (${item.expiresOn})` : item.daysLeft === 0 ? `expires today` : `expires in ${item.daysLeft} days (${item.expiresOn})`;
    const [taskId] = await ownerTask(db, {
      title: `${item.name} ${when}`,
      description: item.type === "SUB_COI" ? "Ask the sub for a current certificate of insurance before assigning more work." : "Renew and upload the new license, then update its expiry date on the Compliance page.",
    });
    await db.update(s.expiryAlerts).set({ taskId }).where(eq(s.expiryAlerts.id, mine.id));
    raised.push({ name: item.name, threshold: tightest });
  }
  return raised;
}
