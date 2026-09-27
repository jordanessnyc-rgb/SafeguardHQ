/** Phase 7a: the owner's "Finish setting up" card reflects live data. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { setupChecklist } from "@/lib/dashboard/setup";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe.skipIf(!hasTestDb)("setup checklist", () => {
  let t: TestDb;
  let owner: TestUser;
  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
  });
  afterAll(async () => t?.close());

  const done = async () => Object.fromEntries((await owner.as((tx) => setupChecklist(tx))).map((i) => [i.key, i.done]));

  it("starts with the setup work open and ticks items off as the data appears", async () => {
    await t.db.update(s.settings).set({ digestEnabled: true, digestRecipients: [], healthAlertPhone: null });
    expect(await done()).toMatchObject({ freshbooks: false, pricing: false, cycles: false, digest: false, alerts: false, team: false, templates: false });

    await t.db.insert(s.pricingRules).values({ serviceCode: "MOLD_ASSESS", baseAmount: "650" });
    await t.db.insert(s.complianceRules).values({ serviceCode: "LL152", cycleMonths: 48 });
    await t.db.insert(s.credentials).values({ name: "NYS DOL Asbestos Handling License" });
    await t.db.update(s.settings).set({ digestRecipients: ["jordan@ess-nyc.com"], healthAlertPhone: "+19295550100" });
    await createUser(t, "VA");
    expect(await done()).toMatchObject({ pricing: true, cycles: true, licenses: true, digest: true, alerts: true, team: true });
  });

  it("asks for the invoice history once FreshBooks is connected, and ticks it when the import finished cleanly", async () => {
    await t.db.insert(s.freshbooksConnection).values({ id: 1, accountId: "ACC1", accessTokenEnc: "x", refreshTokenEnc: "y", expiresAt: new Date() });
    expect(await done()).toMatchObject({ history: false });
    await t.db.update(s.freshbooksConnection).set({ historyRequestedAt: new Date(), historyStatus: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), invoices: 3, jobsCreated: 2, payments: 1 } });
    expect(await done()).toMatchObject({ history: true });
  });
});
