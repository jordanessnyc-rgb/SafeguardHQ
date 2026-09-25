/** Subcontractor portal (SPEC §2): SUB sees only its assigned jobs + released sub copies — enforced in Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("subcontractor portal RLS", () => {
  let t: TestDb;
  let apex: TestUser;
  let other: TestUser;
  let unlinked: TestUser;
  let mine: typeof s.jobs.$inferSelect;
  let theirs: typeof s.jobs.$inferSelect;
  const docs: Record<string, string> = {};

  beforeAll(async () => {
    t = await setupTestDb();
    const [apexOrg] = await t.db.insert(s.organizations).values({ name: "Apex Abatement", type: "SUBCONTRACTOR" }).returning();
    const [otherOrg] = await t.db.insert(s.organizations).values({ name: "Other Sub", type: "SUBCONTRACTOR" }).returning();
    const [client] = await t.db.insert(s.organizations).values({ name: "Secret Client LLC", type: "MANAGEMENT_CO" }).returning();
    apex = await createUser(t, "SUB");
    other = await createUser(t, "SUB");
    unlinked = await createUser(t, "SUB");
    await t.db.update(s.profiles).set({ orgId: apexOrg.id }).where(eq(s.profiles.userId, apex.id));
    await t.db.update(s.profiles).set({ orgId: otherOrg.id }).where(eq(s.profiles.userId, other.id));
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "55 WATER ST", borough: "Brooklyn" }).returning();
    [mine] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_PLAN", pipelineKey: "INSPECTION", stage: "SCHEDULED", propertyId: prop.id, clientOrgId: client.id, subOrgId: apexOrg.id, notes: "Quoted $4,000; client pays net 30", scheduledAt: new Date("2026-10-01T13:00:00Z") }).returning();
    [theirs] = await t.db.insert(s.jobs).values({ serviceCode: "MOLD_PLAN", pipelineKey: "INSPECTION", stage: "SCHEDULED", subOrgId: otherOrg.id }).returning();
    await t.db.insert(s.jobFinancials).values({ jobId: mine.id, quotedAmount: "4000.00", subCost: "1800.00" });
    const doc = async (key: string, v: Partial<typeof s.documents.$inferInsert>) => {
      const [d] = await t.db.insert(s.documents).values({ jobId: mine.id, kind: "SUB_COPY", status: "FINAL", title: key, storageBucket: "job-files", storagePath: `p/${key}`, ...v }).returning();
      docs[key] = d.id;
    };
    await doc("released", {});
    await doc("draft", { status: "DRAFT" });
    await doc("report", { kind: "REPORT" });
    await doc("priced", { containsPricing: true, storageBucket: "job-files-pricing" });
    await doc("consent", { kind: "CONSENT" });
  });
  afterAll(async () => t?.close());

  it("sees only its own assigned jobs, with no client or money columns", async () => {
    const rows = await apex.as((tx) => tx.select().from(s.subPortalJobs));
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    expect(rows[0]).toMatchObject({ jobNumber: mine.jobNumber, addressLine: "55 WATER ST", borough: "Brooklyn" });
    const cols = await apex.as((tx) => tx.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'sub_portal_jobs'`));
    expect(cols.rows.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(["client_org_id"]));
    for (const c of cols.rows.map((r) => r.column_name)) expect(c).not.toMatch(/client|notes|amount|cost|price|contact/);
    expect((await other.as((tx) => tx.select().from(s.subPortalJobs))).map((r) => r.id)).toEqual([theirs.id]);
    expect(await unlinked.as((tx) => tx.select().from(s.subPortalJobs))).toHaveLength(0);
  });

  it("sees only released, non-priced sub copies of its own jobs", async () => {
    const rows = await apex.as((tx) => tx.select().from(s.subPortalDocuments));
    expect(rows.map((r) => r.id)).toEqual([docs.released]);
    expect(await other.as((tx) => tx.select().from(s.subPortalDocuments))).toHaveLength(0);
  });

  it("has no direct access to any table (jobs, money, clients, contacts, documents, profiles of others)", async () => {
    for (const table of [s.jobs, s.jobFinancials, s.subCosts, s.organizations, s.contacts, s.documents, s.properties, s.activities, s.tasks, s.invoicesCache, s.bids, s.pricingRules]) {
      expect(await apex.as((tx) => tx.select().from(table))).toHaveLength(0);
    }
    const profiles = await apex.as((tx) => tx.select().from(s.profiles));
    expect(profiles.map((p) => p.userId)).toEqual([apex.id]); // only itself
    await expect(apex.as((tx) => tx.insert(s.tasks).values({ title: "x" }))).rejects.toThrow();
    await expect(apex.as((tx) => tx.update(s.profiles).set({ role: "OWNER" }).where(eq(s.profiles.userId, apex.id)).returning())).resolves.toHaveLength(0);
  });
});
