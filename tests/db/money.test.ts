/** A/R aging, margin reports (SPEC §6.2) and the daily digest (SPEC §9.7). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { agingBucket, arAging, clientTypeOf, margins } from "@/lib/money/reports";
import { buildDigest, isDigestDue, renderDigestSms, renderDigestText, sendDigestIfDue } from "@/lib/money/digest";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("report helpers", () => {
  const asOf = new Date("2026-09-24T15:00:00Z");
  it("buckets by days past due (falling back to issue date + terms)", () => {
    expect(agingBucket("2026-09-30", null, 30, asOf)).toBe("current");
    expect(agingBucket("2026-09-10", null, 30, asOf)).toBe("1-30");
    expect(agingBucket("2026-08-01", null, 30, asOf)).toBe("31-60");
    expect(agingBucket("2026-07-01", null, 30, asOf)).toBe("61-90");
    expect(agingBucket(null, "2026-05-01", 30, asOf)).toBe("90+");
  });
  it("classifies client types", () => {
    expect(clientTypeOf({ serviceCode: "AIRNYC" })).toBe("AIRNYC");
    expect(clientTypeOf({ orgType: "GOV_AGENCY" })).toBe("GOVERNMENT");
    expect(clientTypeOf({ orgType: "MANAGEMENT_CO" })).toBe("MANAGEMENT_CO");
    expect(clientTypeOf({ orgType: "OWNER" })).toBe("PRIVATE");
    expect(clientTypeOf({})).toBe("PRIVATE");
  });
  it("digest is due on weekdays at/after the configured time (New York)", () => {
    expect(isDigestDue(new Date("2026-09-24T11:29:00Z"), "07:30")).toBe(false); // Thu 7:29 EDT
    expect(isDigestDue(new Date("2026-09-24T11:30:00Z"), "07:30")).toBe(true);
    expect(isDigestDue(new Date("2026-09-26T13:00:00Z"), "07:30")).toBe(false); // Saturday
  });
});

describe.skipIf(!hasTestDb)("money reports + digest (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  const asOf = new Date("2026-09-24T15:00:00Z");

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    const [mgmt] = await t.db.insert(s.organizations).values({ name: "Acme Mgmt", type: "MANAGEMENT_CO" }).returning();
    const [gov] = await t.db.insert(s.organizations).values({ name: "NYC DOE", type: "GOV_AGENCY" }).returning();
    const mk = async (serviceCode: string, orgId: string | null, delivered: string, fin: Partial<typeof s.jobFinancials.$inferInsert>, inv?: Partial<typeof s.invoicesCache.$inferInsert>) => {
      const [job] = await t.db.insert(s.jobs).values({ serviceCode: serviceCode as "LL152", pipelineKey: "INSPECTION", stage: "LEAD", clientOrgId: orgId }).returning();
      await t.db.update(s.jobs).set({ deliveredAt: new Date(delivered) }).where(eq(s.jobs.id, job.id));
      const fbId = inv ? `INV-${job.jobNumber}` : null;
      await t.db.insert(s.jobFinancials).values({ jobId: job.id, freshbooksInvoiceId: fbId, ...fin });
      if (inv) await t.db.insert(s.invoicesCache).values({ freshbooksInvoiceId: fbId!, jobId: job.id, invoiceNumber: fbId, status: "sent", ...inv });
      return job;
    };
    await mk("MOLD_ASSESS", mgmt.id, "2026-08-10T15:00:00Z", { quotedAmount: "1000.00", labCost: "200.00" }, { amount: "1100.00", outstanding: "1100.00", dueAt: "2026-07-01" });
    await mk("MOLD_ASSESS", null, "2026-09-05T15:00:00Z", { quotedAmount: "800.00", subCost: "300.00" }, { amount: "800.00", outstanding: "300.00", dueAt: "2026-09-10" });
    await mk("LL152", gov.id, "2026-09-12T15:00:00Z", { quotedAmount: "2500.00", otherCost: "100.00" }, { amount: "2500.00", outstanding: "2500.00", dueAt: "2026-10-12" });
    await mk("AIRNYC", null, "2026-09-15T15:00:00Z", { quotedAmount: "600.00" }, { amount: "600.00", outstanding: "0.00", dueAt: "2026-09-01" });
    await t.db.insert(s.invoicesCache).values({ freshbooksInvoiceId: "DRAFT-1", status: "draft", amount: "999.00", outstanding: "999.00" });
  });
  afterAll(async () => t?.close());

  it("A/R aging: outstanding by client type and bucket (drafts and paid excluded)", async () => {
    const ar = await owner.as((tx) => arAging(tx, asOf));
    expect(ar.total).toBe(3900);
    expect(ar.grid.MANAGEMENT_CO["61-90"]).toBe(1100);
    expect(ar.grid.PRIVATE["1-30"]).toBe(300);
    expect(ar.grid.GOVERNMENT.current).toBe(2500);
    expect(ar.grid.AIRNYC.current).toBe(0);
    expect(ar.items[0]).toMatchObject({ outstanding: 2500, client: "NYC DOE" });
  });

  it("margins by service and month use invoiced amounts when present", async () => {
    const m = await owner.as((tx) => margins(tx, { from: new Date("2026-08-01T04:00:00Z"), to: new Date("2026-10-01T04:00:00Z") }));
    const mold = m.byService.find((r) => r.key === "MOLD_ASSESS")!;
    expect(mold).toMatchObject({ jobs: 2, revenue: 1900, subCost: 300, labCost: 200, margin: 1400 });
    expect(m.byMonth.map((r) => [r.key, r.revenue])).toEqual([["2026-08", 1100], ["2026-09", 3900]]);
    expect(m.total).toMatchObject({ jobs: 4, revenue: 5000, margin: 4400, marginPct: 88 });
  });

  it("a VA gets empty money reports (RLS), never numbers", async () => {
    const ar = await va.as((tx) => arAging(tx, asOf));
    expect(ar.total).toBe(0);
    const m = await va.as((tx) => margins(tx, { from: new Date("2026-01-01"), to: new Date("2027-01-01") }));
    expect(m.total.revenue).toBe(0);
  });

  it("digest: stale jobs, lab waiting, unpaid, going-cold leads, overdue tasks", async () => {
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "LEAD" }).returning();
    await t.db.update(s.jobs).set({ stageEnteredAt: new Date("2026-09-01T12:00:00Z") }).where(eq(s.jobs.id, job.id));
    await t.db.insert(s.samples).values({ jobId: job.id, sampleId: "S1", type: "AIR", status: "RESULTS_IN" });
    const [lead] = await t.db.insert(s.contacts).values({ firstName: "Cold", lastName: "Lead", phones: ["+13475550000"], source: "QUO" }).returning();
    await t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", contactId: lead.id, body: "quote?", occurredAt: new Date("2026-09-22T15:00:00Z") });
    const [warm] = await t.db.insert(s.contacts).values({ firstName: "Warm", lastName: "Lead", phones: ["+13475550001"] }).returning();
    await t.db.insert(s.activities).values([
      { type: "SMS", direction: "INBOUND", contactId: warm.id, body: "hi", occurredAt: new Date("2026-09-22T15:00:00Z") },
      { type: "SMS", direction: "OUTBOUND", contactId: warm.id, body: "hello!", occurredAt: new Date("2026-09-22T16:00:00Z") },
    ]);
    await t.db.insert(s.tasks).values({ title: "overdue", dueAt: new Date("2026-09-20T12:00:00Z") });

    const d = await buildDigest(t.db, asOf);
    expect(d.staleJobs.map((j) => j.jobNumber)).toContain(job.jobNumber);
    expect(d.labWaiting).toEqual([{ jobNumber: job.jobNumber, samples: 1, stage: "LEAD" }]);
    expect(d.unpaid.total).toBe(3900);
    expect(d.goingCold.map((g) => g.name)).toEqual(["Cold Lead"]);
    expect(d.overdueTasks).toBe(1);
    const { subject, text } = renderDigestText(d, "https://crm.example");
    expect(subject).toMatch(/^ESS digest 2026-09-24: \d+ stale · 1 lab · \$3,900 unpaid · 1 cold leads$/);
    expect(text).toContain("GOING-COLD LEADS (1)");
    expect(renderDigestSms(d)).toMatch(/^ESS 09-24: \d+ stale jobs · 1 lab results to review · \$3,900 unpaid \(\$0 90\+ days\)|^ESS 09-24:/);
  });

  it("sends once per weekday to the configured recipients + SMS", async () => {
    const [line] = await t.db.insert(s.phoneLines).values({ quoPhoneNumberId: "PN1", number: "+19293051232", label: "ESS", lineKey: "ESS_MAIN" }).returning();
    await t.db.update(s.settings).set({ digestRecipients: ["jordan@ess-nyc.com"], healthAlertPhone: "+19175550000", healthAlertLineId: line.id, digestTime: "07:30" });
    const send = vi.fn(async () => ({ messageId: "<d@x>" }));
    const sendSms = vi.fn(async () => ({ id: "AC1" }));
    const deps = { mail: { send }, quo: { sendSms } as never };
    expect(await sendDigestIfDue(t.db, deps, new Date("2026-09-24T11:00:00Z"))).toBe("not-due");
    expect(await sendDigestIfDue(t.db, deps, new Date("2026-09-24T11:31:00Z"))).toBe("sent");
    expect(await sendDigestIfDue(t.db, deps, new Date("2026-09-24T16:00:00Z"))).toBe("already-sent");
    expect(await sendDigestIfDue(t.db, deps, new Date("2026-09-26T13:00:00Z"))).toBe("not-due"); // Saturday
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "jordan@ess-nyc.com", subject: expect.stringMatching(/^ESS digest 2026-09-24/) }));
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ from: "PN1", to: "+19175550000" }));
    const [run] = await owner.as((tx) => tx.select().from(s.digestRuns));
    expect(run).toMatchObject({ runDate: "2026-09-24", error: null });
    expect(await va.as((tx) => tx.select().from(s.digestRuns))).toHaveLength(0);
  });
});
