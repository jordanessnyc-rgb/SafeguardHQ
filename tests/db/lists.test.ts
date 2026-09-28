/**
 * Phase 7b: per-row counts in list pages and the job form's building → company fill-in.
 * Regression: drizzle writes select-list columns unqualified ("id") in single-table queries, so an
 * outer column inside a correlated subquery bound to the subquery's own table and every count was 0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { col } from "@/lib/db/sql";
import { loadJobOptions } from "@/lib/jobs/options";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("list counts and pickers", () => {
  let t: TestDb;
  let owner: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
  });
  afterAll(async () => t?.close());

  it("counts related rows per record in a single-table select, and the job form knows each building's company", async () => {
    const [org] = await t.db.insert(s.organizations).values({ name: "Marbrose Realty", type: "MANAGEMENT_CO" }).returning();
    const [owner2] = await t.db.insert(s.organizations).values({ name: "Owner LLC", type: "OWNER" }).returning();
    const [b1] = await t.db.insert(s.properties).values({ addressLine: "53 WEST 76 STREET" }).returning();
    const [b2] = await t.db.insert(s.properties).values({ addressLine: "1 EMPTY STREET" }).returning();
    await t.db.insert(s.propertyRoles).values([
      { propertyId: b1.id, orgId: owner2.id, role: "OWNER" },
      { propertyId: b1.id, orgId: org.id, role: "MANAGER" },
    ]);
    await t.db.insert(s.jobs).values([
      { serviceCode: "LEAD_RA", pipelineKey: "INSPECTION", stage: "LEAD", propertyId: b1.id, clientOrgId: org.id },
      { serviceCode: "LEAD_RA", pipelineKey: "INSPECTION", stage: "LEAD", propertyId: b1.id, clientOrgId: org.id },
    ]);

    const jobs = sql<number>`(select count(*)::int from ${s.jobs} j where j.property_id = ${col(s.properties.id)})`;
    const rows = await owner.as((tx) => tx.select({ id: s.properties.id, jobs }).from(s.properties));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.jobs]))).toMatchObject({ [b1.id]: 2, [b2.id]: 0 });

    const opts = await owner.as((tx) => loadJobOptions(tx));
    // Manager first: picking the building fills in the company that manages it.
    expect(opts.properties.find((p) => p.id === b1.id)?.orgIds).toEqual([org.id, owner2.id]);
    expect(opts.properties.find((p) => p.id === b2.id)?.orgIds).toEqual([]);
  });
});
