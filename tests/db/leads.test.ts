/** Web leads + campaign attribution (SPEC §11). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { findOrCreateLeadByPhone } from "@/lib/comms/contacts";
import { acceptWebLead, recordScan, WebLeadSchema } from "@/lib/marketing/leads";
import { campaignResults } from "@/lib/marketing/results";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

const geo = (async () =>
  new Response(
    JSON.stringify({
      features: [{ geometry: { coordinates: [-73.99, 40.7] }, properties: { label: "55 Water Street, Brooklyn, NY, USA", name: "55 Water Street", housenumber: "55", street: "Water Street", borough: "Brooklyn", postalcode: "11201", confidence: 0.9, addendum: { pad: { bbl: "3000350001", bin: "3000001" } } } }],
    }),
  )) as unknown as typeof fetch;

describe("web lead validation", () => {
  it("needs an email or a valid phone", () => {
    expect(WebLeadSchema.safeParse({ name: "Pat" }).success).toBe(false);
    expect(WebLeadSchema.safeParse({ name: "Pat", phone: "12" }).success).toBe(false);
    expect(WebLeadSchema.safeParse({ name: "Pat", phone: "718-555-0100" }).success).toBe(true);
  });
});

describe.skipIf(!hasTestDb)("web leads + campaign attribution (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let mailer: typeof s.campaigns.$inferSelect;
  const now = new Date("2026-09-24T15:00:00Z");

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    await t.db.insert(s.phoneLines).values({ quoPhoneNumberId: "PN1", number: "+19293051232", label: "ESS main", lineKey: "ESS_MAIN" });
    await t.db.insert(s.phoneLines).values({ quoPhoneNumberId: "PN2", number: "+19295550000", label: "LL152 mailer line", lineKey: "LL152_MAILER" });
    [mailer] = await t.db.insert(s.campaigns).values({ name: "LL152 mailer Oct", channel: "DIRECT_MAIL", tracking: { qrSlug: "ll152-oct", quoNumber: "+19295550000", landingUrl: "https://ess-nyc.com/ll152" } }).returning();
    await t.db.insert(s.campaignCosts).values({ campaignId: mailer.id, cost: "1200.00" });
  });
  afterAll(async () => t?.close());

  it("creates contact + resolved property + Lead job + task + DRAFT ack, credited to the campaign", async () => {
    const out = await acceptWebLead(t.db, { name: "Dana Ortiz", email: "Dana@Example.com", phone: "(718) 555-0199", address: "55 water st brooklyn", service: "LL152", message: "Got your mailer — need an LL152 inspection.", campaign: "LL152-OCT" }, { fetch: geo, now });
    expect(out.status).toBe("created");
    const [c] = await t.db.select().from(s.contacts).where(eq(s.contacts.id, out.contactId!));
    expect(c).toMatchObject({ firstName: "Dana", lastName: "Ortiz", emails: ["dana@example.com"], phones: ["+17185550199"], source: "MAILER_CAMPAIGN", campaignId: mailer.id });
    const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, out.jobId!));
    expect(j).toMatchObject({ stage: "LEAD", serviceCode: "LL152", source: "WEB_FORM", campaignId: mailer.id, clientContactId: c.id });
    const [p] = await t.db.select().from(s.properties).where(eq(s.properties.id, j.propertyId!));
    expect(p).toMatchObject({ addressLine: "55 Water Street", borough: "Brooklyn", zip: "11201", bbl: "3000350001" });
    const [task] = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, j.id));
    expect(task.title).toBe("New web lead — Dana Ortiz, 55 water st brooklyn");
    const [draft] = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.jobId, j.id));
    expect(draft).toMatchObject({ status: "DRAFT", channel: "SMS", templateKey: "NEW_LEAD_ACK", toAddress: "+17185550199" }); // never auto-sent here

    expect((await acceptWebLead(t.db, { name: "Dana Ortiz", email: "dana@example.com" }, { fetch: geo, now: new Date(now.getTime() + 60_000) })).status).toBe("duplicate");
    const again = await acceptWebLead(t.db, { name: "Dana Ortiz", email: "dana@example.com", campaign: "other" }, { fetch: geo, now: new Date(now.getTime() + 3600_000) });
    expect(again.contactId).toBe(c.id); // same person, new job; first-touch campaign kept
    const [c2] = await t.db.select().from(s.contacts).where(eq(s.contacts.id, c.id));
    expect(c2.campaignId).toBe(mailer.id);
  });

  it("honeypot submissions create nothing", async () => {
    const before = (await t.db.select().from(s.contacts)).length;
    expect((await acceptWebLead(t.db, { name: "Bot", email: "bot@spam.test", website: "http://spam" }, { fetch: geo, now })).status).toBe("spam");
    expect(await t.db.select().from(s.contacts)).toHaveLength(before);
  });

  it("QR scans are counted and redirect with utm tags; unknown slugs don't count", async () => {
    expect(await recordScan(t.db, "ll152-oct")).toBe("https://ess-nyc.com/ll152?utm_campaign=ll152-oct&utm_medium=qr");
    expect(await recordScan(t.db, "nope")).toBeNull();
    expect(await t.db.select().from(s.campaignEvents)).toHaveLength(1);
  });

  it("a new caller on the campaign's dedicated number is credited to it", async () => {
    const { contact } = await findOrCreateLeadByPhone(t.db, "+13475550111", { lineNumber: "+19295550000" });
    expect(contact).toMatchObject({ campaignId: mailer.id, source: "MAILER_CAMPAIGN" });
    const { contact: plain } = await findOrCreateLeadByPhone(t.db, "+13475550112", { lineNumber: "+19293051232" });
    expect(plain).toMatchObject({ campaignId: null, source: "QUO" });
  });

  it("results: counts for staff; revenue and cost only for the owner", async () => {
    const [won] = await t.db.select().from(s.jobs).where(eq(s.jobs.campaignId, mailer.id)).limit(1);
    await t.db.update(s.jobs).set({ stage: "QUALIFIED" }).where(eq(s.jobs.id, won.id));
    await t.db.update(s.jobs).set({ stage: "SIGNED" }).where(eq(s.jobs.id, won.id));
    await t.db.insert(s.jobFinancials).values({ jobId: won.id, quotedAmount: "900.00" });
    const o = (await owner.as((tx) => campaignResults(tx))).get(mailer.id)!;
    expect(o).toMatchObject({ scans: 1, leads: 2, won: 1, revenue: 900, cost: 1200 });
    const v = (await va.as((tx) => campaignResults(tx))).get(mailer.id)!;
    expect(v).toMatchObject({ scans: 1, leads: 2, won: 1, revenue: null, cost: null });
  });
});
