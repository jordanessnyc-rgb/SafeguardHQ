import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { enrichProperty } from "@/lib/properties/enrich";
import type { EnrichmentResult, NormalizedViolation } from "@/lib/integrations/nyc-open-data";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

const v = (id: string, isOpen = true): NormalizedViolation => ({
  source: "HPD",
  violationId: id,
  class: "C",
  orderNumber: "510",
  status: isOpen ? "NOV SENT OUT" : "VIOLATION CLOSED",
  isOpen,
  issuedDate: "2026-09-01",
  description: `Mold condition ${id}`,
  raw: { violationid: id },
});

const data = (violations: NormalizedViolation[], errors: string[] = []): EnrichmentResult => ({
  facts: { buildingClass: "C1", unitsRes: 12, yearBuilt: 1930, ownerName: "NYC HOUSING AUTHORITY", isNycha: true },
  registration: { registrationId: "306068", endDate: "2026-09-01", contacts: [] },
  violations,
  errors,
});

describe.skipIf(!hasTestDb)("enrichProperty", () => {
  let t: TestDb;
  let va: TestUser;
  let propertyId: string;

  beforeAll(async () => {
    t = await setupTestDb();
    va = await createUser(t, "VA");
    [{ id: propertyId }] = await va.as((tx) =>
      tx.insert(s.properties).values({ addressLine: "22 STAGG STREET", bbl: "3030310015", bin: "3327904" }).returning(),
    );
  });
  afterAll(async () => t?.close());

  it("caches facts + violations on first run without alerting", async () => {
    const out = await va.as((tx) => enrichProperty(tx, propertyId, async () => data([v("1"), v("2", false)])));
    expect(out).toMatchObject({ status: "OK", violationCount: 2, openCount: 1, newOpenViolations: 0, tasksCreated: 0 });
    const [p] = await va.as((tx) => tx.select().from(s.properties).where(eq(s.properties.id, propertyId)));
    expect(p).toMatchObject({ buildingClass: "C1", unitsRes: 12, isNycha: true, hpdRegistrationId: "306068", enrichmentStatus: "OK" });
  });

  it("is idempotent (re-running upserts, no duplicates)", async () => {
    await va.as((tx) => enrichProperty(tx, propertyId, async () => data([v("1"), v("2", false)])));
    const rows = await va.as((tx) => tx.select().from(s.propertyViolations));
    expect(rows).toHaveLength(2);
  });

  it("new open violation without an active relationship → no task", async () => {
    const out = await va.as((tx) => enrichProperty(tx, propertyId, async () => data([v("1"), v("2", false), v("3")])));
    expect(out.newOpenViolations).toBe(1);
    expect(out.tasksCreated).toBe(0);
  });

  it("new open violation on a property with an active job → outreach task", async () => {
    await va.as((tx) =>
      tx.insert(s.jobs).values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "LEAD", propertyId }),
    );
    const out = await va.as((tx) => enrichProperty(tx, propertyId, async () => data([v("1"), v("2", false), v("3"), v("4")])));
    expect(out).toMatchObject({ newOpenViolations: 1, tasksCreated: 1 });
    const tasks = await va.as((tx) => tx.select().from(s.tasks).where(eq(s.tasks.propertyId, propertyId)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ source: "SYSTEM_RULE" });
    expect(tasks[0].title).toMatch(/1 HPD/);
  });

  it("status changes flow through (open → closed)", async () => {
    await va.as((tx) => enrichProperty(tx, propertyId, async () => data([v("1", false), v("2", false), v("3"), v("4")])));
    const [row] = await va.as((tx) => tx.select().from(s.propertyViolations).where(eq(s.propertyViolations.violationId, "1")));
    expect(row.isOpen).toBe(false);
  });

  it("records a total failure without wiping previous data", async () => {
    const out = await va.as((tx) =>
      enrichProperty(tx, propertyId, async () => ({ facts: null, registration: null, violations: [], errors: ["PLUTO: 500"] })),
    );
    expect(out.status).toBe("FAILED");
    const [p] = await va.as((tx) => tx.select().from(s.properties).where(eq(s.properties.id, propertyId)));
    expect(p.enrichmentStatus).toBe("FAILED");
    expect(p.enrichedAt).not.toBeNull();
    expect(p.buildingClass).toBe("C1");
  });
});

describe.skipIf(!hasTestDb)("worker: active properties", () => {
  it("includes properties with non-Lost jobs, active owner/manager roles, or open AIRnyc cases only", async () => {
    const t = await setupTestDb();
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const va = await createUser(t, "VA");
    const ids = await va.as(async (tx) => {
      const mk = async (a: string) => (await tx.insert(s.properties).values({ addressLine: a }).returning())[0].id;
      const [openJob, lostJob, manager, tenant, none] = await Promise.all(["open", "lost", "mgr", "tenant", "none"].map(mk));
      await tx.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "SCHEDULED", propertyId: openJob });
      await tx.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LOST", lostReason: "price", propertyId: lostJob });
      const [c] = await tx.insert(s.contacts).values({ lastName: "X" }).returning();
      await tx.insert(s.propertyRoles).values({ propertyId: manager, contactId: c.id, role: "MANAGER" });
      await tx.insert(s.propertyRoles).values({ propertyId: tenant, contactId: c.id, role: "TENANT" });
      return { openJob, lostJob, manager, tenant, none };
    });
    const { activePropertyIds } = await import("@/worker/index");
    const active = await activePropertyIds();
    expect(active.sort()).toEqual([ids.openJob, ids.manager].sort());
    await t.close();
  });
});
