/**
 * Long-running worker (Railway / Fly.io). Phase 1: nightly NYC Open Data refresh for active
 * properties (SPEC §6.5). Phase 2 adds the Titan IMAP listener and integration queues here.
 *
 * Uses the privileged DATABASE_URL connection (no user session): writes bypass RLS by design.
 */
import "dotenv/config";
import { and, isNull, or, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { adminDb, schema as s } from "@/lib/db";
import { enrichProperty } from "@/lib/properties/enrich";

const Q = {
  nightly: "enrich-active-properties",
  one: "enrich-property",
  dead: "dead-letter",
} as const;

/**
 * Same "active relationship" as lib/properties/enrich.ts: any job that wasn't Lost, an active
 * OWNER/MANAGER contact, or an open AIRnyc case.
 */
export async function activePropertyIds(): Promise<string[]> {
  const db = adminDb();
  const rows = await db
    .selectDistinct({ id: s.properties.id })
    .from(s.properties)
    .where(
      and(
        isNull(s.properties.archivedAt),
        or(
          sql`exists (select 1 from ${s.jobs} j where j.property_id = ${s.properties.id} and j.archived_at is null and j.stage <> 'LOST')`,
          sql`exists (select 1 from ${s.propertyRoles} r where r.property_id = ${s.properties.id} and r.active and r.role in ('OWNER','MANAGER'))`,
          sql`exists (select 1 from ${s.airnycCases} c where c.property_id = ${s.properties.id} and c.archived_at is null and c.stage not in ('PAID','LOST'))`,
        ),
      ),
    );
  return rows.map((r) => r.id);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const boss = new PgBoss(url);
  boss.on("error", (e) => console.error("[pg-boss]", e));
  await boss.start();

  await boss.createQueue(Q.dead);
  await boss.createQueue(Q.nightly, { retryLimit: 2, retryBackoff: true, deadLetter: Q.dead });
  await boss.createQueue(Q.one, { retryLimit: 3, retryDelay: 60, retryBackoff: true, deadLetter: Q.dead });

  // 3:00 AM New York, after the city's overnight dataset refreshes.
  await boss.schedule(Q.nightly, "0 3 * * *", null, { tz: "America/New_York" });

  await boss.work(Q.nightly, async () => {
    const ids = await activePropertyIds();
    for (const propertyId of ids) {
      await boss.send(Q.one, { propertyId }, { singletonKey: propertyId });
    }
    console.log(`[nightly] queued ${ids.length} properties for enrichment`);
  });

  await boss.work<{ propertyId: string }>(Q.one, async ([job]) => {
    const out = await enrichProperty(adminDb(), job.data.propertyId);
    if (out.status === "FAILED") throw new Error(out.errors.join("; ")); // retried with backoff
    console.log(`[enrich] ${job.data.propertyId}: ${out.status}, ${out.openCount} open, ${out.newOpenViolations} new`);
  });

  console.log("Worker started.");
  const stop = async () => {
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

