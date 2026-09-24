/**
 * FreshBooks (SPEC §6.2). Phase 3 acceptance: "marking a test job Delivered creates a correct
 * draft invoice in FreshBooks, and a test payment moves the job to Paid."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import * as s from "@/db/schema";
import { encryptField, decryptField } from "@/lib/crypto";
import { FreshBooksClient, pythonJsonDumps, signFreshbooks, verifyFreshbooksSignature } from "@/lib/integrations/freshbooks";
import { createDraftInvoiceForJob, invoiceDeliveredJobs, reportHeld } from "@/lib/money/invoicing";
import { handleFreshbooksWebhook } from "@/lib/money/freshbooks-webhook";
import { registerWebhooks } from "@/lib/money/freshbooks-setup";
import { importFreshbooksClients, resolveImportedClient } from "@/lib/money/client-sync";
import { FakeFreshBooks } from "../helpers/fake-freshbooks";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

describe("FreshBooks webhook signature (Python json.dumps semantics)", () => {
  const pairs: [string, string][] = [["name", "payment.create"], ["object_id", "1234"], ["account_id", "ACC1"], ["business_id", "77"]];
  it("reproduces Python's separators", () => {
    expect(pythonJsonDumps(pairs)).toBe('{"name": "payment.create", "object_id": "1234", "account_id": "ACC1", "business_id": "77"}');
    expect(pythonJsonDumps([["n", "café"]])).toBe('{"n": "caf\\u00e9"}');
  });
  it("verifies against any stored verifier, in received or sorted key order", () => {
    const sig = signFreshbooks("ver-2", pairs);
    expect(verifyFreshbooksSignature(sig, pairs, ["ver-1", "ver-2"])).toBe(true);
    const sortedSig = signFreshbooks("ver-1", [...pairs].sort(([a], [b]) => a.localeCompare(b)));
    expect(verifyFreshbooksSignature(sortedSig, pairs, ["ver-1"])).toBe(true);
    expect(verifyFreshbooksSignature(sig, pairs, ["ver-9"])).toBe(false);
    expect(verifyFreshbooksSignature(null, pairs, ["ver-2"])).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("FreshBooks integration", () => {
  let t: TestDb;
  let fake: FakeFreshBooks;
  let fb: FreshBooksClient;
  let owner: TestUser;
  let va: TestUser;
  const cfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://crm.example/api/freshbooks/callback" };
  const HOOK = "https://crm.example/api/webhooks/freshbooks";

  const connect = async (expiresInMs = 3600_000) =>
    t.db
      .insert(s.freshbooksConnection)
      .values({ id: 1, accountId: "ACC1", accessTokenEnc: encryptField(fake.accessToken)!, refreshTokenEnc: encryptField(fake.refreshToken)!, expiresAt: new Date(Date.now() + expiresInMs) })
      .onConflictDoUpdate({
        target: s.freshbooksConnection.id,
        set: { accessTokenEnc: encryptField(fake.accessToken)!, refreshTokenEnc: encryptField(fake.refreshToken)!, expiresAt: new Date(Date.now() + expiresInMs) },
      });

  const deliveredJob = async (fin: Partial<typeof s.jobFinancials.$inferInsert> | null, extra: Partial<typeof s.jobs.$inferInsert> = {}) => {
    const [org] = await t.db.insert(s.organizations).values({ name: "Acme Management LLC", type: "MANAGEMENT_CO", email: `ap-${randomBytes(3).toString("hex")}@acmemgmt.com` }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "420 CENTRAL PARK WEST", unit: "2E", borough: "Manhattan", zip: "10025" }).returning();
    const [job] = await t.db
      .insert(s.jobs)
      .values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "QA", propertyId: prop.id, clientOrgId: org.id, ...extra })
      .returning();
    if (fin) await t.db.insert(s.jobFinancials).values({ jobId: job.id, ...fin });
    await t.db.insert(s.documents).values({ jobId: job.id, kind: "REPORT", status: "FINAL" });
    await t.db.update(s.jobs).set({ stage: "DELIVERED" }).where(eq(s.jobs.id, job.id));
    return { job, org };
  };

  const webhook = (form: [string, string][], verifier: string | null) =>
    handleFreshbooksWebhook(t.db, fb, new URLSearchParams(form).toString(), verifier ? signFreshbooks(verifier, form) : null);

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    fake = new FakeFreshBooks();
    fb = new FreshBooksClient(t.db, cfg, fake.fetch as never);
    await connect();
  });
  afterAll(async () => t?.close());

  describe("tokens", () => {
    it("refreshes an expiring token once, even under concurrent requests, and stores the rotated pair encrypted", async () => {
      await connect(30_000); // expires in 30s → inside the 2-minute refresh window
      const before = fake.refreshCount;
      await Promise.all([fb.accountId(), fb.listClients(), fb.listClients(), fb.listClients()]);
      expect(fake.refreshCount).toBe(before + 1); // single-use refresh token never raced
      const [c] = await t.db.select().from(s.freshbooksConnection);
      expect(decryptField(c.refreshTokenEnc)).toBe(fake.refreshToken);
      expect(c.refreshTokenEnc).not.toContain(fake.refreshToken);
    });
  });

  describe("invoice on Delivered (acceptance)", () => {
    it("creates a correct DRAFT invoice: client, line items, property address, job number; nothing emailed", async () => {
      const { job, org } = await deliveredJob({
        quotedAmount: "1850.00",
        lineItems: [
          { description: "Mold assessment", quantity: 1, unitPrice: 1450 },
          { description: "Air samples", quantity: 4, unitPrice: 100 },
        ],
      });
      const out = await invoiceDeliveredJobs(t.db, fb);
      expect(out).toContainEqual(expect.objectContaining({ status: "created" }));

      const inv = fake.invoices.at(-1)!;
      expect(inv.v3_status).toBe("draft");
      expect(inv.lines).toEqual([
        { type: 0, name: "Mold assessment", qty: 1, unit_cost: { amount: "1450.00", code: "USD" } },
        { type: 0, name: "Air samples", qty: 4, unit_cost: { amount: "100.00", code: "USD" } },
      ]);
      expect((inv.amount as { amount: string }).amount).toBe("1850.00");
      expect(inv.notes).toContain(`ESS job ${job.jobNumber}`);
      expect(inv.notes).toContain("420 CENTRAL PARK WEST, Apt 2E, Manhattan 10025");
      const client = fake.clients.find((c) => c.id === inv.customerid)!;
      expect(client).toMatchObject({ organization: "Acme Management LLC", email: org.email });
      expect(fake.emailed).toHaveLength(0); // auto-send is off → stays a draft

      const [fin] = await t.db.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, job.id));
      expect(fin).toMatchObject({ freshbooksInvoiceId: String(inv.id), invoiceStatus: "draft", invoiceError: null });
      const [o] = await t.db.select().from(s.organizations).where(eq(s.organizations.id, org.id));
      expect(o.freshbooksClientId).toBe(String(client.id));
      const [cache] = await t.db.select().from(s.invoicesCache).where(eq(s.invoicesCache.freshbooksInvoiceId, String(inv.id)));
      expect(cache).toMatchObject({ jobId: job.id, amount: "1850.00", outstanding: "1850.00", status: "draft" });
    });

    it("never creates a second invoice — including after a crash between FreshBooks and our DB", async () => {
      const { job } = await deliveredJob({ quotedAmount: "900.00" });
      await createDraftInvoiceForJob(t.db, fb, job.id);
      const count = fake.invoices.length;
      await createDraftInvoiceForJob(t.db, fb, job.id); // already recorded → "exists"
      // Simulate the crash: FreshBooks has it, we lost the id; the retry comes later.
      await t.db.update(s.jobFinancials).set({ freshbooksInvoiceId: null, invoiceAttemptAt: new Date(Date.now() - 10 * 60_000) }).where(eq(s.jobFinancials.jobId, job.id));
      const out = await createDraftInvoiceForJob(t.db, fb, job.id);
      expect(out.status).toBe("exists");
      expect(fake.invoices.length).toBe(count);
    });

    it("two simultaneous attempts (worker + stage move) create exactly one invoice", async () => {
      const { job } = await deliveredJob({ quotedAmount: "450.00" });
      const before = fake.invoices.length;
      const outs = await Promise.all([createDraftInvoiceForJob(t.db, fb, job.id), createDraftInvoiceForJob(t.db, fb, job.id)]);
      expect(outs.map((o) => o.status).sort()).toEqual(["created", "skipped"]);
      expect(fake.invoices.length).toBe(before + 1);
    });

    it("no line items or amount → error on the job + one owner task (not repeated)", async () => {
      const { job } = await deliveredJob(null);
      expect((await createDraftInvoiceForJob(t.db, fb, job.id)).status).toBe("error");
      await createDraftInvoiceForJob(t.db, fb, job.id);
      const tasks = await t.db.select().from(s.tasks).where(and(eq(s.tasks.jobId, job.id), like(s.tasks.title, "Couldn't draft%")));
      expect(tasks).toHaveLength(1);
      expect(tasks[0].assignee).toBe(owner.id);
    });

    it("with auto-send on, the draft is emailed to the billing contact", async () => {
      await t.db.update(s.settings).set({ autoCreateInvoice: true });
      const { job, org } = await deliveredJob({ quotedAmount: "500.00" });
      await createDraftInvoiceForJob(t.db, fb, job.id);
      expect(fake.emailed.at(-1)!.recipients).toEqual([org.email]);
      await t.db.update(s.settings).set({ autoCreateInvoice: false });
    });

    it("the automatic loop skips jobs delivered before FreshBooks was connected (may already be billed)", async () => {
      const { job } = await deliveredJob({ quotedAmount: "700.00" });
      await t.db.update(s.jobs).set({ deliveredAt: new Date("2020-01-01T12:00:00Z") }).where(eq(s.jobs.id, job.id));
      await invoiceDeliveredJobs(t.db, fb, 100);
      const [fin] = await t.db.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, job.id));
      expect(fin.freshbooksInvoiceId).toBeNull();
      expect((await createDraftInvoiceForJob(t.db, fb, job.id)).status).toBe("created"); // manual button still works
    });
  });

  describe("webhooks", () => {
    it("registers one callback per event and completes the verifier handshake (unknown ids rejected)", async () => {
      await registerWebhooks(t.db, fb, HOOK);
      expect(fake.callbacks.map((c) => c.event)).toEqual(expect.arrayContaining(["invoice.update", "payment.create", "client.update"]));
      await registerWebhooks(t.db, fb, HOOK); // idempotent
      expect(new Set(fake.callbacks.map((c) => c.event)).size).toBe(fake.callbacks.length);

      for (const cb of fake.callbacks) {
        const r = await webhook([["name", "callback.verify"], ["object_id", String(cb.callbackid)], ["verifier", cb.verifier]], null);
        expect(r.status).toBe(200);
      }
      expect(fake.callbacks.every((c) => c.verified)).toBe(true);
      const bad = await webhook([["name", "callback.verify"], ["object_id", "999999"], ["verifier", "x"]], null);
      expect(bad.status).toBe(401);
    });

    it("keeps every verifier when FreshBooks sends all the handshakes at once", async () => {
      const uri = "https://crm.example/api/webhooks/freshbooks-concurrent";
      await registerWebhooks(t.db, fb, uri);
      const mine = fake.callbacks.filter((c) => c.uri === uri);
      const results = await Promise.all(mine.map((cb) => webhook([["name", "callback.verify"], ["object_id", String(cb.callbackid)], ["verifier", cb.verifier]], null)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const [c] = await t.db.select().from(s.freshbooksConnection);
      for (const cb of mine) expect(c.webhookCallbacks![String(cb.callbackid)]).toMatchObject({ verified: true, verifierEnc: expect.any(String) });
      await registerWebhooks(t.db, fb, uri); // re-registering never drops a stored verifier
      const [again] = await t.db.select().from(s.freshbooksConnection);
      for (const cb of mine) expect(again.webhookCallbacks![String(cb.callbackid)].verifierEnc).toBeTruthy();
    });

    it("rejects unsigned or wrongly signed deliveries", async () => {
      const form: [string, string][] = [["name", "invoice.update"], ["object_id", "1"], ["account_id", "ACC1"]];
      expect((await webhook(form, null)).status).toBe(401);
      expect((await webhook(form, "not-a-verifier")).status).toBe(401);
    });

    it("invoice sent → job Invoiced", async () => {
      const { job } = await deliveredJob({ quotedAmount: "700.00" });
      const { invoiceId } = await createDraftInvoiceForJob(t.db, fb, job.id);
      fake.invoices.find((i) => String(i.id) === invoiceId)!.v3_status = "sent";
      const r = await webhook([["name", "invoice.update"], ["object_id", invoiceId!], ["account_id", "ACC1"]], fake.callbacks[0].verifier);
      expect(r.status).toBe(200);
      const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
      expect(j.stage).toBe("INVOICED");
    });

    it("payment (acceptance): partial → Invoiced (not Paid); full payment → Paid, review task once, held report released", async () => {
      const [contact] = await t.db.insert(s.contacts).values({ firstName: "Pat", lastName: "Lee", phones: ["+17185550100"] }).returning();
      const { job } = await deliveredJob({ quotedAmount: "1000.00", holdReportUntilPaid: true }, { clientContactId: contact.id });
      const { invoiceId } = await createDraftInvoiceForJob(t.db, fb, job.id);
      const verifier = fake.callbacks.find((c) => c.event === "payment.create")!.verifier;

      const p1 = fake.pay(invoiceId!, 400);
      await webhook([["name", "payment.create"], ["object_id", p1], ["account_id", "ACC1"]], verifier);
      let [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
      expect(j.stage).toBe("INVOICED"); // a partially paid invoice was evidently sent
      let [fin] = await t.db.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, job.id));
      expect(fin).toMatchObject({ amountPaid: "400.00", invoiceStatus: "partial", paidAt: null });

      const p2 = fake.pay(invoiceId!, 600);
      const form: [string, string][] = [["name", "payment.create"], ["object_id", p2], ["account_id", "ACC1"]];
      await webhook(form, verifier);
      await webhook(form, verifier); // FreshBooks retry / duplicate
      await webhook([["name", "invoice.update"], ["object_id", invoiceId!], ["account_id", "ACC1"]], verifier); // late invoice event

      [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
      expect(j.stage).toBe("PAID");
      [fin] = await t.db.select().from(s.jobFinancials).where(eq(s.jobFinancials.jobId, job.id));
      expect(fin.amountPaid).toBe("1000.00");
      expect(fin.paidAt).not.toBeNull();
      expect(fin.reportReleasedAt).not.toBeNull();
      const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.jobId, job.id));
      expect(tasks.filter((x) => x.title.startsWith("Ask Pat Lee for a review"))).toHaveLength(1);
      expect(tasks.filter((x) => x.title.startsWith("Paid — release the report"))).toHaveLength(1);
      const payments = await t.db.select().from(s.paymentsCache).where(eq(s.paymentsCache.jobId, job.id));
      expect(payments.map((p) => p.amount).sort()).toEqual(["400.00", "600.00"]);
    });

    it("hold-until-paid resolves job flag → client organization flag → settings default", async () => {
      const [org] = await t.db.insert(s.organizations).values({ name: "Hold Co", holdReportUntilPaid: true }).returning();
      expect(await reportHeld(t.db, { clientOrgId: org.id }, null)).toBe(true);
      expect(await reportHeld(t.db, { clientOrgId: org.id }, { holdReportUntilPaid: false })).toBe(false);
      expect(await reportHeld(t.db, { clientOrgId: null }, { holdReportUntilPaid: null })).toBe(false);
      await t.db.update(s.settings).set({ holdReportUntilPaidDefault: true });
      expect(await reportHeld(t.db, { clientOrgId: null }, null)).toBe(true);
      await t.db.update(s.settings).set({ holdReportUntilPaidDefault: false });
    });

    it("payments and FreshBooks tokens are invisible to a VA", async () => {
      expect(await va.as((tx) => tx.select().from(s.paymentsCache))).toHaveLength(0);
      expect(await va.as((tx) => tx.select().from(s.freshbooksConnection))).toHaveLength(0);
      expect((await owner.as((tx) => tx.select().from(s.paymentsCache))).length).toBeGreaterThan(0);
    });
  });

  describe("client import with duplicate review", () => {
    it("suggests matches by email / company name / person, and resolves link, create, ignore", async () => {
      const [org] = await t.db.insert(s.organizations).values({ name: "Parkview Realty Group", type: "MANAGEMENT_CO", email: "billing@parkview.com" }).returning();
      const [named] = await t.db.insert(s.organizations).values({ name: "Hudson Property Mgmt, LLC", type: "MANAGEMENT_CO" }).returning();
      fake.clients.push(
        { id: 501, organization: "Parkview Realty", email: "billing@parkview.com", vis_state: 0 },
        { id: 502, organization: "HUDSON PROPERTY MGMT", email: "x@hudson.com", vis_state: 0 },
        { id: 503, organization: "Brand New Co", fname: "Dana", lname: "Ortiz", email: "dana@newco.com", vis_state: 0 },
        { id: 504, organization: "Spam Inc", vis_state: 0 },
        { id: 505, organization: "Deleted Co", vis_state: 1 },
      );
      await importFreshbooksClients(t.db, fb);
      const rows = Object.fromEntries((await t.db.select().from(s.freshbooksClients)).map((r) => [r.freshbooksClientId, r]));
      expect(rows["501"]).toMatchObject({ matchStatus: "PENDING", suggestedOrgId: org.id, matchReason: "same email" });
      expect(rows["502"]).toMatchObject({ suggestedOrgId: named.id, matchReason: "same company name" });
      expect(rows["503"].suggestedOrgId).toBeNull();
      expect(rows["505"]).toBeUndefined();

      await owner.as((tx) => resolveImportedClient(tx, "501", { action: "link", orgId: org.id }));
      await owner.as((tx) => resolveImportedClient(tx, "503", { action: "create" }));
      await owner.as((tx) => resolveImportedClient(tx, "504", { action: "ignore" }));
      const [linked] = await t.db.select().from(s.organizations).where(eq(s.organizations.id, org.id));
      expect(linked.freshbooksClientId).toBe("501");
      const [created] = await t.db.select().from(s.organizations).where(eq(s.organizations.name, "Brand New Co"));
      expect(created.freshbooksClientId).toBe("503");
      const [dana] = await t.db.select().from(s.contacts).where(eq(s.contacts.lastName, "Ortiz"));
      expect(dana).toMatchObject({ orgId: created.id, emails: ["dana@newco.com"] });

      // Re-import keeps decisions.
      await importFreshbooksClients(t.db, fb);
      const after = Object.fromEntries((await t.db.select().from(s.freshbooksClients)).map((r) => [r.freshbooksClientId, r.matchStatus]));
      expect(after).toMatchObject({ "501": "LINKED", "503": "LINKED", "504": "IGNORED" });
    });

    it("a VA can see the review list but can't resolve it", async () => {
      expect((await va.as((tx) => tx.select().from(s.freshbooksClients))).length).toBeGreaterThan(0);
      await expect(va.as((tx) => resolveImportedClient(tx, "502", { action: "ignore" }))).resolves.toBeUndefined();
      const [row] = await t.db.select().from(s.freshbooksClients).where(eq(s.freshbooksClients.freshbooksClientId, "502"));
      expect(row.matchStatus).toBe("PENDING"); // RLS: the VA's update touched nothing
    });
  });
});
