/** Owner two-step sign-in (Phase 6): the database grants an OWNER nothing until the session is aal2. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { runAsUser } from "@/lib/db";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("owner MFA enforced by RLS", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "LEAD" }).returning();
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, quotedAmount: "900.00" });
  });
  afterAll(async () => t?.close());

  const as = (u: TestUser, aal?: string) => <T>(fn: Parameters<typeof runAsUser<T>>[2]) => runAsUser(t.db, aal ? { ...u.claims, aal } : u.claims, fn);

  it("an owner at aal1 sees no money and no jobs", async () => {
    expect(await as(owner, "aal1")((tx) => tx.select().from(s.jobFinancials))).toEqual([]);
    expect(await as(owner, "aal1")((tx) => tx.select().from(s.jobs))).toEqual([]);
  });
  it("the same owner at aal2 sees everything", async () => {
    expect(await as(owner, "aal2")((tx) => tx.select().from(s.jobFinancials))).toHaveLength(1);
  });
  it("still reads their own profile at aal1 (so the app knows to ask for the code)", async () => {
    expect(await as(owner, "aal1")((tx) => tx.select().from(s.profiles))).toEqual([expect.objectContaining({ userId: owner.id, role: "OWNER" })]);
  });
  it("VAs are unaffected; claims without aal (worker, MCP) are unaffected", async () => {
    expect(await as(va, "aal1")((tx) => tx.select().from(s.jobs))).toHaveLength(1);
    expect(await as(owner)((tx) => tx.select().from(s.jobFinancials))).toHaveLength(1);
  });
});
