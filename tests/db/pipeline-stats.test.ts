/** Phase 7d: won / lost numbers on the pipeline board. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { loadPipelines } from "@/lib/pipeline/config";
import { boardStats, salesStages, winLoss } from "@/lib/pipeline/stats";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("pipeline board stats", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
  });
  afterAll(async () => t?.close());

  it("counts jobs that left the sales stages as won, Lost as lost, and ignores imported history", async () => {
    const job = (stage: string) => t.db.insert(s.jobs).values({ serviceCode: "LEAD_RA", pipelineKey: "INSPECTION", stage }).returning().then((r) => r[0]);
    const a = await job("LEAD");
    const b = await job("PROPOSAL_SENT");
    const c = await job("LEAD");
    const d = await job("QUALIFIED");
    await job("CLOSED"); // imported history: created Closed, never in a sales stage
    await t.db.insert(s.jobFinancials).values([{ jobId: a.id, quotedAmount: "1200.00" }, { jobId: d.id, quotedAmount: "800.00" }]);
    await t.db.update(s.jobs).set({ stage: "SIGNED" }).where(eq(s.jobs.id, a.id));
    await t.db.update(s.jobs).set({ stage: "SIGNED" }).where(eq(s.jobs.id, b.id));
    await t.db.update(s.jobs).set({ stage: "LOST", lostReason: "Price" }).where(eq(s.jobs.id, c.id));

    const inspection = (await owner.as((tx) => loadPipelines(tx))).find((p) => p.key === "INSPECTION")!;
    expect(salesStages(inspection)).toEqual(["LEAD", "QUALIFIED", "PROPOSAL_SENT"]);
    const st = await owner.as((tx) => boardStats(tx, inspection));
    expect(st).toMatchObject({ won: 2, wonValue: 1200, lost: 1, topLossReason: "Price", winRate: 67, decided90: 3, openSales: 1, openValue: 800 });

    // A VA sees the counts but no money (job_financials is owner-only under RLS).
    const vaStats = await va.as((tx) => boardStats(tx, inspection));
    expect(vaStats).toMatchObject({ won: 2, lost: 1, wonValue: null, openValue: null });
  });
});

describe.skipIf(!hasTestDb)("win/loss report", () => {
  let t: TestDb;
  let owner: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
  });
  afterAll(async () => t?.close());

  it("groups leads by source and service, with win rate and loss reasons; history is left out", async () => {
    const lead = (source: "WEB_FORM" | "QUO" | "REFERRAL", serviceCode: "LEAD_RA" | "MOLD_ASSESS" = "LEAD_RA") =>
      t.db.insert(s.jobs).values({ serviceCode, pipelineKey: "INSPECTION", stage: "LEAD", source }).returning().then((r) => r[0]);
    const w1 = await lead("WEB_FORM");
    const w2 = await lead("WEB_FORM", "MOLD_ASSESS");
    const l1 = await lead("QUO");
    await lead("REFERRAL"); // still open
    await t.db.insert(s.jobs).values({ serviceCode: "LEAD_RA", pipelineKey: "INSPECTION", stage: "CLOSED", jobNumber: "FB-1" }); // imported
    await t.db.update(s.jobs).set({ stage: "PROPOSAL_SENT" }).where(eq(s.jobs.id, w1.id));
    await t.db.update(s.jobs).set({ stage: "SIGNED" }).where(eq(s.jobs.id, w1.id));
    await t.db.update(s.jobs).set({ stage: "SIGNED" }).where(eq(s.jobs.id, w2.id));
    await t.db.update(s.jobs).set({ stage: "LOST", lostReason: "Chose another firm" }).where(eq(s.jobs.id, l1.id));

    const wl = await owner.as(async (tx) => winLoss(tx, await loadPipelines(tx)));
    expect(wl.total).toMatchObject({ leads: 4, won: 2, lost: 1, open: 1, winRate: 67 });
    expect(wl.bySource.find((r) => r.key === "WEB_FORM")).toMatchObject({ leads: 2, won: 2, winRate: 100, avgDaysToWin: 0 });
    expect(wl.bySource.find((r) => r.key === "QUO")).toMatchObject({ leads: 1, lost: 1, winRate: 0 });
    expect(wl.byService.find((r) => r.key === "MOLD_ASSESS")).toMatchObject({ leads: 1, won: 1 });
    expect(wl.lossReasons).toEqual([{ reason: "Chose another firm", n: 1 }]);
  });
});
