/** Compliance calendar (SPEC §6.6), credential/COI alerts (SPEC §10) and their digest sections. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import * as s from "@/db/schema";
import { addMonths, scheduleNextCycles, upcomingCycles } from "@/lib/compliance/cycles";
import { daysUntil, raiseExpiryAlerts } from "@/lib/compliance/expiry";
import { buildDigest, renderDigestText } from "@/lib/money/digest";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("date helpers", () => {
  it("adds months, clamping to the end of the month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-09-24", 60)).toBe("2031-09-24");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
  it("counts days in New York time", () => {
    expect(daysUntil("2026-09-25", new Date("2026-09-25T02:00:00Z"))).toBe(1); // still Sep 24 in NY
    expect(daysUntil("2026-09-20", new Date("2026-09-24T15:00:00Z"))).toBe(-4);
  });
});

describe.skipIf(!hasTestDb)("compliance calendar + expiry alerts (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  const now = new Date("2026-09-24T15:00:00Z");

  const closedJob = async (serviceCode: "LL152" | "MOLD_ASSESS" | "LL126" | "LEAD_RA", extra: Partial<typeof s.jobs.$inferInsert> = {}) => {
    const [org] = await t.db.insert(s.organizations).values({ name: `Client ${serviceCode}`, type: "MANAGEMENT_CO" }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "100 BROADWAY", borough: "Manhattan" }).returning();
    const [job] = await t.db
      .insert(s.jobs)
      .values({ serviceCode, pipelineKey: "INSPECTION", stage: "CLOSED", propertyId: prop.id, clientOrgId: org.id, fieldCompletedAt: new Date("2026-03-10T15:00:00Z"), ...extra })
      .returning();
    return { job, org };
  };

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
  });
  afterAll(async () => t?.close());

  it("rules are Jordan's: the owner enters them, a VA can read but not change them", async () => {
    await owner.as((tx) =>
      tx.insert(s.complianceRules).values([
        { serviceCode: "LL152", cycleMonths: 48, leadTimeDays: 90, notes: "Per DOB district schedule" },
        { serviceCode: "LL126", cycleMonths: null, notes: "FISP-style cycle — set by hand" },
      ]),
    );
    expect(await va.as((tx) => tx.select().from(s.complianceRules))).toHaveLength(2);
    await expect(va.as((tx) => tx.insert(s.complianceRules).values({ serviceCode: "MOLD_ASSESS", cycleMonths: 12 }))).rejects.toThrow();
    const upd = await va.as((tx) => tx.update(s.complianceRules).set({ cycleMonths: 1 }).where(eq(s.complianceRules.serviceCode, "LL152")).returning());
    expect(upd).toHaveLength(0);
  });

  it("a closed job gets its next cycle from the rule + one outreach task at the lead time", async () => {
    const { job } = await closedJob("LL152");
    const out = await scheduleNextCycles(t.db, now);
    expect(out).toContainEqual({ jobNumber: job.jobNumber, status: "scheduled", nextCycleDue: "2030-03-10" });
    const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
    expect(j.nextCycleDue).toBe("2030-03-10");
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, job.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toMatch(/due 2030-03-10 — Client LL152, 100 BROADWAY, Manhattan/);
    expect(tasks[0].dueAt!.toISOString()).toBe("2029-12-10T14:00:00.000Z"); // 90 days before, 9 AM EST
    expect(tasks[0].assignee).toBe(owner.id);

    await scheduleNextCycles(t.db, now); // idempotent
    expect(await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, job.id))).toHaveLength(1);
  });

  it("keeps a date set by hand; asks for one when the rule has no cycle length; ignores services without a rule", async () => {
    const { job: manual } = await closedJob("LL152", { nextCycleDue: "2028-01-15" });
    const { job: noLength } = await closedJob("LL126");
    const { job: noRule } = await closedJob("MOLD_ASSESS");
    const out = await scheduleNextCycles(t.db, now);
    expect(out).toContainEqual({ jobNumber: manual.jobNumber, status: "kept", nextCycleDue: "2028-01-15" });
    expect(out).toContainEqual({ jobNumber: noLength.jobNumber, status: "manual", nextCycleDue: null });
    const [ask] = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, noLength.id));
    expect(ask.title).toMatch(/^Set the next .* cycle for /);
    const [n] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, noRule.id));
    expect(n.cycleScheduledAt).toBeNull(); // picked up later if Jordan adds a MOLD rule
  });

  it("calendar view filters by client and borough", async () => {
    const { job, org } = await closedJob("LL152", { nextCycleDue: "2026-11-01" });
    const all = await owner.as((tx) => upcomingCycles(tx, "2026-09-24", "2026-12-31"));
    expect(all.map((c) => c.jobNumber)).toContain(job.jobNumber);
    expect((await va.as((tx) => upcomingCycles(tx, "2026-09-24", "2026-12-31", { orgId: org.id }))).map((c) => c.jobNumber)).toEqual([job.jobNumber]);
    expect(await owner.as((tx) => upcomingCycles(tx, "2026-09-24", "2026-12-31", { borough: "Queens" }))).toHaveLength(0);
  });

  it("the three ESS licenses are seeded (numbers/dates for Jordan to fill in); only the owner edits them", async () => {
    const creds = await va.as((tx) => tx.select().from(s.credentials));
    expect(creds.map((c) => c.name).sort()).toEqual(["EPA Lead Risk Assessor", "EPA Lead-Safe Firm", "NYS Mold Assessor"]);
    expect(await va.as((tx) => tx.update(s.credentials).set({ number: "X" }).returning())).toHaveLength(0);
    expect(await owner.as((tx) => tx.update(s.credentials).set({ number: "NY-1" }).where(eq(s.credentials.name, "NYS Mold Assessor")).returning())).toHaveLength(1);
  });

  it("license alerts: 60 → 30 → 7 → expired, one task each; late entry raises only the tightest; renewal restarts", async () => {
    const [cred] = await t.db.select().from(s.credentials).where(eq(s.credentials.name, "EPA Lead-Safe Firm"));
    await t.db.update(s.credentials).set({ expiresAt: "2026-11-08" }).where(eq(s.credentials.id, cred.id)); // 45 days out
    const titles = async () => (await t.db.select().from(s.tasks).where(like(s.tasks.title, "EPA Lead-Safe Firm%"))).map((x) => x.title);

    expect(await raiseExpiryAlerts(t.db, now)).toEqual([{ name: "EPA Lead-Safe Firm", threshold: 60 }]);
    expect(await raiseExpiryAlerts(t.db, now)).toEqual([]);
    await raiseExpiryAlerts(t.db, new Date("2026-10-15T15:00:00Z")); // 24 days left
    await raiseExpiryAlerts(t.db, new Date("2026-11-03T15:00:00Z")); // 5 days left
    await raiseExpiryAlerts(t.db, new Date("2026-11-10T15:00:00Z")); // expired
    expect(await titles()).toEqual([
      "EPA Lead-Safe Firm expires in 45 days (2026-11-08)",
      "EPA Lead-Safe Firm expires in 24 days (2026-11-08)",
      "EPA Lead-Safe Firm expires in 5 days (2026-11-08)",
      "EPA Lead-Safe Firm expired 2 days ago (2026-11-08)",
    ]);

    await t.db.update(s.credentials).set({ expiresAt: "2028-11-08" }).where(eq(s.credentials.id, cred.id)); // renewed
    expect(await raiseExpiryAlerts(t.db, new Date("2026-11-10T15:00:00Z"))).toEqual([]);
    expect(await raiseExpiryAlerts(t.db, new Date("2028-10-01T15:00:00Z"))).toEqual([{ name: "EPA Lead-Safe Firm", threshold: 60 }]);

    const [late] = await t.db.select().from(s.credentials).where(eq(s.credentials.name, "EPA Lead Risk Assessor"));
    await t.db.update(s.credentials).set({ expiresAt: "2026-09-29" }).where(eq(s.credentials.id, late.id)); // entered with 5 days left
    expect(await raiseExpiryAlerts(t.db, now)).toEqual([{ name: "EPA Lead Risk Assessor", threshold: 7 }]);
    const rows = await t.db.select().from(s.expiryAlerts).where(and(eq(s.expiryAlerts.subjectId, late.id)));
    expect(rows.map((r) => r.thresholdDays).sort((a, b) => a - b)).toEqual([7, 30, 60]);
  });

  it("sub COI alerts; a VA can keep a sub's insurance date current", async () => {
    const [sub] = await t.db.insert(s.organizations).values({ name: "Apex Abatement", type: "SUBCONTRACTOR" }).returning();
    await va.as((tx) => tx.insert(s.subProfiles).values({ orgId: sub.id, trades: ["mold remediation"], insuranceExpires: "2026-10-20" }));
    const raised = await raiseExpiryAlerts(t.db, now);
    expect(raised).toContainEqual({ name: "Apex Abatement — insurance (COI)", threshold: 30 });
  });

  it("the digest lists expiring licenses/COIs and cycles coming due", async () => {
    const d = await buildDigest(t.db, now);
    expect(d.expiring.map((e) => e.name)).toEqual(expect.arrayContaining(["EPA Lead Risk Assessor", "Apex Abatement — insurance (COI)"]));
    expect(d.cyclesDue.map((c) => c.due)).toContain("2026-11-01");
    const { text } = renderDigestText(d);
    expect(text).toContain("LICENSES & INSURANCE EXPIRING");
    expect(text).toContain("COMPLIANCE CYCLES DUE IN 60 DAYS");
  });
});
