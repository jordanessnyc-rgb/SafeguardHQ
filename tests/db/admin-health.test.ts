/** Phase 6b: dead-letter queue, worker status, integration health, audit coverage. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import * as s from "@/db/schema";
import { assessHeartbeat, assessTask, loadHealth, recordRun } from "@/lib/admin/health";
import { auditChanges } from "@/lib/admin/audit";
import { DEAD_LETTER_QUEUE, dismissDeadJobs, listDeadJobs, retryDeadJobs } from "@/lib/admin/dead-letter";
import { createUser, hasTestDb, setupTestDb, TEST_DATABASE_URL, type TestDb, type TestUser } from "../helpers/db";

const now = new Date("2026-09-25T15:00:00Z");
const mins = (n: number) => new Date(now.getTime() - n * 60_000);

describe("health assessment", () => {
  const row = (r: Partial<typeof s.workerStatus.$inferSelect>) => ({ name: "triage", lastRunAt: null, lastOkAt: null, lastErrorAt: null, lastError: null, intervalSeconds: 60, ...r });
  it("flags failing, stalled and healthy tasks", () => {
    expect(assessTask(row({ lastOkAt: mins(10), lastErrorAt: mins(1), lastError: "boom" }), now)).toMatchObject({ level: "error", detail: expect.stringContaining("boom") });
    expect(assessTask(row({ lastOkAt: mins(1), lastErrorAt: mins(10) }), now).level).toBe("ok");
    expect(assessTask(row({ lastOkAt: mins(5) }), now).level).toBe("warn"); // 3 × 60 s without success
    expect(assessTask(row({}), now).level).toBe("warn");
  });
  it("treats a missing or old heartbeat as the worker being down", () => {
    expect(assessHeartbeat(undefined, now).level).toBe("error");
    expect(assessHeartbeat(row({ name: "heartbeat", lastOkAt: mins(6) }), now).level).toBe("error");
    expect(assessHeartbeat(row({ name: "heartbeat", lastOkAt: mins(1) }), now).level).toBe("ok");
  });
});

describe("audit summary", () => {
  it("shows changed fields for updates and key fields for inserts", () => {
    expect(auditChanges("UPDATE", { old: { id: 1, quoted_amount: "900.00", sub_cost: null, updated_at: "a" }, new: { id: 1, quoted_amount: "950.00", sub_cost: null, updated_at: "b" } })).toBe("quoted_amount: 900.00 → 950.00");
    expect(auditChanges("INSERT", { new: { id: 1, job_id: "j", quoted_amount: "900.00", sub_cost: null } })).toBe("job_id: j; quoted_amount: 900.00");
  });
});

describe.skipIf(!hasTestDb)("admin health (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
  });
  afterAll(async () => t?.close());

  it("records worker runs; only the owner can read them", async () => {
    await recordRun(t.db, "heartbeat", 60, null, mins(1));
    await recordRun(t.db, "invoices", 60, null, mins(3));
    await recordRun(t.db, "invoices", 60, new Error("FreshBooks 503"), mins(2));
    const h = await owner.as((tx) => loadHealth(tx, now));
    expect(h.integrations[0]).toMatchObject({ name: "Worker", level: "ok" });
    expect(h.tasks).toEqual([expect.objectContaining({ name: "invoices", level: "error", detail: expect.stringContaining("FreshBooks 503") })]);
    expect(await va.as((tx) => tx.select().from(s.workerStatus))).toEqual([]);
  });

  it("reports webhook failures in the last day", async () => {
    await t.db.insert(s.webhookDeliveries).values([
      { provider: "QUO", deliveryId: "a", eventType: "message.received", receivedAt: mins(30) },
      { provider: "QUO", deliveryId: "b", eventType: "call.completed", receivedAt: mins(20), error: "bad signature" },
    ]);
    const h = await owner.as((tx) => loadHealth(tx, now));
    expect(h.integrations.find((i) => i.name === "Quo webhooks")).toMatchObject({ level: "error", detail: expect.stringContaining("bad signature") });
    expect(h.integrations.find((i) => i.name === "FreshBooks")).toMatchObject({ level: "off" });
  });

  it("every table holding money has the audit trigger (SPEC §13)", async () => {
    const { rows } = await t.pool.query<{ table: string; audited: boolean }>(`
      select c.relname as table,
             exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'audit_row_change') as audited
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and a.atttypid = 'numeric'::regtype and a.attname ~ '(amount|cost|paid|outstanding|margin|per_)')
        and c.relname not in ('ai_calls', 'settings')  -- API spend and the AI cost cap, not client money
      order by 1`);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => !r.audited).map((r) => r.table)).toEqual([]);
  });

  it("lists, retries and dismisses dead-lettered jobs", async () => {
    const boss = new PgBoss({ connectionString: TEST_DATABASE_URL!, supervise: false, schedule: false });
    await boss.start();
    try {
      await boss.createQueue(DEAD_LETTER_QUEUE);
      await boss.createQueue("enrich-property", { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE });
      await boss.send("enrich-property", { propertyId: "p1" });
      const [job] = await boss.fetch("enrich-property");
      await boss.fail("enrich-property", job.id, new Error("GeoSearch timed out"));

      const dead = await listDeadJobs(boss);
      expect(dead).toEqual([expect.objectContaining({ queue: "enrich-property", data: { propertyId: "p1" }, error: expect.stringContaining("GeoSearch timed out") })]);

      expect(await retryDeadJobs(boss, [dead[0].id])).toBe(1);
      expect(await listDeadJobs(boss)).toEqual([]);
      const [again] = await boss.fetch("enrich-property");
      expect(again.data).toEqual({ propertyId: "p1" });

      await boss.fail("enrich-property", again.id, new Error("still down"));
      const [d2] = await listDeadJobs(boss);
      await dismissDeadJobs(boss, [d2.id]);
      expect(await listDeadJobs(boss)).toEqual([]);
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 30_000);
});
