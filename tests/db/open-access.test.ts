import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openAccessOwner } from "@/lib/auth/open-access";
import { runAsUser, schema as s } from "@/lib/db";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "@/tests/helpers/db";
let t: TestDb; let owner: TestUser; let va: TestUser;
describe.skipIf(!hasTestDb)("existing owner for no-login access", () => {
  beforeAll(async () => { t = await setupTestDb(); va = await createUser(t, "VA"); });
  afterAll(async () => { await t?.close(); });
  it("fails when no owner exists instead of granting a new account permissions", async () => {
    await expect(openAccessOwner(t.db)).rejects.toThrow("exactly one ESS owner");
    owner = await createUser(t, "OWNER");
  });
  it("selects the sole existing owner and uses normal RLS claims for CRM operations", async () => {
    const profile = await openAccessOwner(t.db);
    expect(profile.userId).toBe(owner.id);
    const claims = { sub: profile.userId, role: "authenticated", email: profile.email, open_access: true };
    const rows = await runAsUser(t.db, claims, tx => tx.select().from(s.profiles));
    expect(rows.some(r => r.userId === owner.id)).toBe(true);
  });
  it("does not accept a non-owner or invalid requested profile", async () => {
    await expect(openAccessOwner(t.db, va.id)).rejects.toThrow("exactly one ESS owner");
    await expect(openAccessOwner(t.db, "bad-id")).rejects.toThrow("UUID");
  });
  it("requires an explicit choice when multiple owners exist", async () => {
    await createUser(t, "OWNER");
    await expect(openAccessOwner(t.db)).rejects.toThrow("exactly one ESS owner");
    expect((await openAccessOwner(t.db, owner.id)).userId).toBe(owner.id);
  });
});
