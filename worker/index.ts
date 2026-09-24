/**
 * Long-running worker (Railway / Fly.io):
 *  - nightly NYC Open Data refresh for active properties (SPEC §6.5, pg-boss schedule)
 *  - Titan IMAP listener → email ingest, EMSL parser (SPEC §6.3)
 *  - AI triage of inbound email/SMS (SPEC §9.1), every 30s
 *  - mail health check → SMS alert to Jordan (every 5 min)
 *  - FreshBooks draft invoices for Delivered jobs (every minute, SPEC §6.2)
 *  - weekday daily digest (checked every 5 min, sent once per day, SPEC §9.7)
 *
 * Uses the privileged DATABASE_URL connection (no user session): writes bypass RLS by design.
 */
import "dotenv/config";
import { and, isNull, or, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { adminDb, schema as s } from "@/lib/db";
import { enrichProperty } from "@/lib/properties/enrich";
import { triagePending } from "@/lib/ai/classify";
import { driveFromEnv } from "@/lib/integrations/google-drive";
import { quoFromEnv } from "@/lib/integrations/quo";
import { mailSenderFromEnv, titanConfigFromEnv } from "@/lib/integrations/titan-mail";
import { freshbooksFromEnv } from "@/lib/integrations/freshbooks";
import { invoiceDeliveredJobs } from "@/lib/money/invoicing";
import { sendDigestIfDue } from "@/lib/money/digest";
import { storageUploader } from "@/lib/supabase/service";
import { mailHealthCheck } from "./health";
import { runMailListener } from "./mail";

/** Runs fn every `ms`, never overlapping itself. */
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, (e as Error).message);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, ms);
}

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

  const timers: NodeJS.Timeout[] = [];
  const abort = new AbortController();

  const titan = titanConfigFromEnv();
  if (titan) {
    void runMailListener({ db: adminDb(), cfg: titan, storage: storageUploader(), drive: driveFromEnv() }, abort.signal);
    const quo = quoFromEnv();
    const startedAt = new Date();
    timers.push(every(5 * 60_000, "mail-health", () => mailHealthCheck(adminDb(), titan.user, quo, new Date(), startedAt)));
  } else {
    console.log("[mail] TITAN_USER/TITAN_PASSWORD not set — email listener disabled");
  }

  if (process.env.ANTHROPIC_API_KEY) {
    timers.push(every(30_000, "triage", () => triagePending(adminDb())));
  } else {
    console.log("[triage] ANTHROPIC_API_KEY not set — inbound messages stay PENDING for manual review");
  }

  const fb = freshbooksFromEnv(adminDb());
  if (fb) {
    timers.push(
      every(60_000, "invoices", async () => {
        for (const o of await invoiceDeliveredJobs(adminDb(), fb)) console.log(`[invoices] ${o.status} ${o.invoiceId ?? ""} ${o.reason ?? ""}`.trim());
      }),
    );
  } else {
    console.log("[invoices] FRESHBOOKS_CLIENT_ID/SECRET not set — no draft invoices");
  }

  timers.push(
    every(5 * 60_000, "digest", async () => {
      const r = await sendDigestIfDue(adminDb(), { mail: mailSenderFromEnv(), quo: quoFromEnv() });
      if (r === "sent" || r === "no-recipients") console.log(`[digest] ${r}`);
    }),
  );

  console.log("Worker started.");
  const stop = async () => {
    abort.abort();
    timers.forEach(clearInterval);
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

