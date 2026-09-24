/** Stage rules enforced by the database (SPEC §5) + job numbering, mirrored by lib/pipeline/rules. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { checkStageTransition, stageRuleMessage } from "@/lib/pipeline/rules";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("pipeline stage rules (database)", () => {
  let t: TestDb;
  let va: TestUser;

  beforeAll(async () => {
    t = await setupTestDb();
    await createUser(t, "OWNER");
    va = await createUser(t, "VA");
  });
  afterAll(async () => t?.close());

  const newJob = (stage = "LEAD", pipelineKey = "INSPECTION") =>
    va.as(async (tx) => {
      const [j] = await tx
        .insert(s.jobs)
        .values({ serviceCode: pipelineKey === "INSPECTION" ? "MOLD_ASSESS" : "MOLD_PLAN", pipelineKey, stage })
        .returning();
      return j;
    });

  const move = (id: string, stage: string, lostReason?: string) =>
    va.as((tx) => tx.update(s.jobs).set({ stage, ...(lostReason ? { lostReason } : {}) }).where(eq(s.jobs.id, id)).returning());

  const blocked = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return stageRuleMessage(e);
    }
    return null;
  };

  it("assigns sequential ESS-YYYY-#### job numbers", async () => {
    const a = await newJob();
    const b = await newJob();
    const year = new Date().toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric" });
    expect(a.jobNumber).toMatch(new RegExp(`^ESS-${year}-\\d{4}$`));
    expect(Number(b.jobNumber.slice(-4))).toBe(Number(a.jobNumber.slice(-4)) + 1);
  });

  it("rejects a stage that isn't in the job's pipeline", async () => {
    const j = await newJob();
    await expect(move(j.id, "SUBMITTED_TO_AGENCY")).rejects.toThrow();
  });

  it("Lab Pending requires ≥1 SUBMITTED sample", async () => {
    const j = await newJob("FIELD_COMPLETE");
    expect(await blocked(move(j.id, "LAB_PENDING"))).toMatch(/SUBMITTED/);

    await va.as((tx) => tx.insert(s.samples).values({ jobId: j.id, sampleId: "A-1", type: "AIR" }));
    expect(await blocked(move(j.id, "LAB_PENDING"))).toMatch(/SUBMITTED/); // COLLECTED isn't enough

    await va.as((tx) => tx.update(s.samples).set({ status: "SUBMITTED" }).where(eq(s.samples.jobId, j.id)));
    const [moved] = await move(j.id, "LAB_PENDING");
    expect(moved.stage).toBe("LAB_PENDING");
  });

  it("Delivered requires a FINAL report document (draft/QA or non-report kinds don't count)", async () => {
    const j = await newJob("QA");
    expect(await blocked(move(j.id, "DELIVERED"))).toMatch(/FINAL report/);

    await va.as((tx) => tx.insert(s.documents).values({ jobId: j.id, kind: "REPORT", status: "QA" }));
    await va.as((tx) => tx.insert(s.documents).values({ jobId: j.id, kind: "PHOTO_LOG", status: "FINAL" }));
    expect(await blocked(move(j.id, "DELIVERED"))).toMatch(/FINAL report/);

    await va.as((tx) =>
      tx.update(s.documents).set({ status: "FINAL" }).where(and(eq(s.documents.jobId, j.id), eq(s.documents.kind, "REPORT"))),
    );
    const [moved] = await move(j.id, "DELIVERED");
    expect(moved.stage).toBe("DELIVERED");
    expect(moved.deliveredAt).toBeInstanceOf(Date);
  });

  it("the Delivered check sees priced reports the VA can't (trigger is SECURITY DEFINER)", async () => {
    const j = await newJob("QA");
    const owner = await createUser(t, "OWNER");
    await owner.as((tx) =>
      tx.insert(s.documents).values({ jobId: j.id, kind: "REPORT", status: "FINAL", containsPricing: true }),
    );
    const [moved] = await move(j.id, "DELIVERED");
    expect(moved.stage).toBe("DELIVERED");
  });

  it("jobs can't be created directly in a gated stage", async () => {
    expect(await blocked(newJob("DELIVERED"))).toMatch(/FINAL report/);
  });

  it("Lost requires a reason and an open starting stage", async () => {
    const j = await newJob("PROPOSAL_SENT");
    expect(await blocked(move(j.id, "LOST"))).toMatch(/lost reason/i);
    expect(await blocked(move(j.id, "LOST", "   "))).toMatch(/lost reason/i);
    const [lost] = await move(j.id, "LOST", "Went with a cheaper firm");
    expect(lost.stage).toBe("LOST");

    const closed = await newJob("CLOSED");
    expect(await blocked(move(closed.id, "LOST", "n/a"))).toMatch(/open stage/);
  });

  it("stage changes land on the job timeline", async () => {
    const j = await newJob("LEAD");
    await move(j.id, "QUALIFIED");
    const acts = await va.as((tx) =>
      tx.select().from(s.activities).where(and(eq(s.activities.jobId, j.id), eq(s.activities.type, "STAGE_CHANGE"))),
    );
    expect(acts.map((a) => a.subject)).toEqual(expect.arrayContaining(["Job created in LEAD", "LEAD → QUALIFIED"]));
    expect(acts.every((a) => a.createdBy === va.id)).toBe(true);
  });

  it("work-plan pipeline has its own stages", async () => {
    const j = await newJob("LEAD", "WORK_PLAN");
    const [m] = await move(j.id, "SUBMITTED_TO_AGENCY");
    expect(m.stage).toBe("SUBMITTED_TO_AGENCY");
  });
});

describe("checkStageTransition (UI mirror)", () => {
  const base = { fromStage: "QA", fromStageIsTerminal: false, submittedSampleCount: 0, finalReportCount: 0 };
  it("matches the trigger's rules", () => {
    expect(checkStageTransition({ ...base, toStage: "DELIVERED" })).toHaveLength(1);
    expect(checkStageTransition({ ...base, toStage: "DELIVERED", finalReportCount: 1 })).toEqual([]);
    expect(checkStageTransition({ ...base, toStage: "LAB_PENDING" })).toHaveLength(1);
    expect(checkStageTransition({ ...base, toStage: "LAB_PENDING", submittedSampleCount: 2 })).toEqual([]);
    expect(checkStageTransition({ ...base, toStage: "LOST" })).toHaveLength(1);
    expect(checkStageTransition({ ...base, toStage: "LOST", lostReason: "price" })).toEqual([]);
    expect(
      checkStageTransition({ ...base, fromStage: "CLOSED", fromStageIsTerminal: true, toStage: "LOST", lostReason: "x" }),
    ).toHaveLength(1);
    expect(checkStageTransition({ ...base, toStage: "QA" })).toEqual([]);
  });
});
