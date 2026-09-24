/**
 * Quo webhooks (SPEC §6.1, Phase 2 acceptance: "duplicate webhook deliveries create no duplicate
 * records"; calls/SMS land on the right contact's timeline).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { signWebhook, verifyWebhook, WebhookVerificationError, type QuoEvent } from "@/lib/integrations/quo";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const LINE_PN = "PNessMain01";
const AIRNYC_PN = "PNairnyc001";
const CALLER = "+17185550123";

const headersFor = (id: string, body: string, ts = Math.floor(Date.now() / 1000)) =>
  new Headers({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${signWebhook(SECRET, id, String(ts), body)}` });

describe("verifyWebhook (Standard Webhooks)", () => {
  const body = JSON.stringify({ hello: "world" });
  it("accepts a valid signature and returns the delivery id", () => {
    expect(verifyWebhook(SECRET, headersFor("msg_1", body), body)).toBe("msg_1");
  });
  it("accepts when any of several rotated signatures matches", () => {
    const h = headersFor("msg_1", body);
    h.set("webhook-signature", `v1,AAAA ${h.get("webhook-signature")}`);
    expect(verifyWebhook(SECRET, h, body)).toBe("msg_1");
  });
  it("rejects a tampered body, a wrong secret, and a stale timestamp", () => {
    expect(() => verifyWebhook(SECRET, headersFor("msg_1", body), body + " ")).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook(`whsec_${randomBytes(24).toString("base64")}`, headersFor("msg_1", body), body)).toThrow(WebhookVerificationError);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() => verifyWebhook(SECRET, headersFor("msg_1", body, old), body)).toThrow(/tolerance/);
  });
  it("rejects missing headers", () => {
    expect(() => verifyWebhook(SECRET, new Headers(), body)).toThrow(/Missing/);
  });
});

describe.skipIf(!hasTestDb)("Quo webhook processing", () => {
  let t: TestDb;
  let contactId: string;
  let POST: (req: Request) => Promise<Response>;

  const msgEvent = (id: string, text: string, from = CALLER, pn = LINE_PN): QuoEvent => ({
    id: `EV${randomUUID()}`,
    type: "message.received",
    apiVersion: "2026-03-30",
    data: {
      resource: { id, direction: "incoming", text, status: "received", createdAt: new Date().toISOString() },
      context: { phoneNumberId: pn, conversationId: "CN1", senderIdentifier: from, recipientIdentifiers: ["+19293051232"] },
      links: { quo: `https://my.quo.com/inbox/${id}` },
    },
  });
  const callEvent = (id: string, status: string, from = CALLER): QuoEvent => ({
    id: `EV${randomUUID()}`,
    type: "call.completed",
    data: {
      resource: { id, direction: "incoming", status, createdAt: new Date().toISOString(), duration: status === "answered" ? 184 : 0 },
      context: { phoneNumberId: LINE_PN, participants: { workspace: ["+19293051232"], external: [from] } },
      links: { quo: `https://my.quo.com/call/${id}` },
    },
  });
  const summaryEvent = (callId: string): QuoEvent => ({
    id: `EV${randomUUID()}`,
    type: "call.summary.completed",
    data: {
      resource: { callId, processingStatus: "completed", summary: ["Tenant reports mold in bathroom.", "Wants an assessment next week."], nextSteps: ["Send proposal", "Schedule inspection"] },
      context: { phoneNumberId: LINE_PN },
    },
  });

  const deliver = async (event: QuoEvent, deliveryId = `msg_${randomUUID()}`) => {
    const body = JSON.stringify(event);
    const res = await POST(new Request("http://localhost/api/webhooks/quo", { method: "POST", headers: headersFor(deliveryId, body), body }));
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  };

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    process.env.QUO_WEBHOOK_SECRET = SECRET;
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    delete process.env.QUO_API_KEY;
    t = await setupTestDb();
    ({ POST } = await import("@/app/api/webhooks/quo/route"));
    await t.db.insert(s.phoneLines).values([
      { quoPhoneNumberId: LINE_PN, number: "+19293051232", label: "ESS main", lineKey: "ESS_MAIN", missedCallTextback: true },
      { quoPhoneNumberId: AIRNYC_PN, number: "+19293050000", label: "AIRnyc line", lineKey: "AIRNYC" },
    ]);
    [{ id: contactId }] = await t.db.insert(s.contacts).values({ firstName: "Pat", lastName: "Lee", phones: ["+17185550100"] }).returning();
  });
  afterAll(async () => t?.close());

  it("rejects unsigned requests with 401", async () => {
    const res = await POST(new Request("http://localhost/api/webhooks/quo", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("an SMS lands on the matching contact's timeline", async () => {
    const r = await deliver(msgEvent("AC-known-1", "Can you come Tuesday?", "+17185550100"));
    expect(r.status).toBe(200);
    const [a] = await t.db.select().from(s.activities).where(eq(s.activities.externalId, "AC-known-1"));
    expect(a).toMatchObject({ type: "SMS", direction: "INBOUND", contactId, body: "Can you come Tuesday?", channelLine: "ESS_MAIN", triageStatus: "PENDING" });
    expect(a.externalUrl).toBe("https://my.quo.com/inbox/AC-known-1");
  });

  it("duplicate deliveries of the same webhook create no duplicate records", async () => {
    const event = msgEvent("AC-dupe-1", "hello");
    const first = await deliver(event, "msg_same");
    const second = await deliver(event, "msg_same");
    const third = await deliver(event, "msg_other_endpoint_retry"); // same event, new delivery id
    expect(first.json).toMatchObject({ ok: true });
    expect(second.json).toMatchObject({ duplicate: true });
    expect(third.status).toBe(200);
    const rows = await t.db.select().from(s.activities).where(eq(s.activities.externalId, "AC-dupe-1"));
    expect(rows).toHaveLength(1);
    const deliveries = await t.db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.deliveryId, "msg_same"));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].processedAt).not.toBeNull();
  });

  it("an unknown number creates a lead contact and a qualify task — once", async () => {
    await deliver(msgEvent("AC-new-1", "Do you do lead testing?", "+13475550199"));
    await deliver(msgEvent("AC-new-2", "Hello?", "+13475550199"));
    const leads = await t.db.select().from(s.contacts).where(sql`'+13475550199' = any(${s.contacts.phones})`);
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe("QUO");
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.contactId, leads[0].id));
    expect(tasks.map((x) => x.title)).toEqual(["New inbound — qualify +13475550199"]);
  });

  it("out-of-order: summary before call.completed ends with both, and next steps become tasks once", async () => {
    await deliver(summaryEvent("CA-ooo-1"));
    await deliver(summaryEvent("CA-ooo-1")); // redelivered with a new id
    await deliver(callEvent("CA-ooo-1", "answered", "+17185550100"));
    const [a] = await t.db.select().from(s.activities).where(and(eq(s.activities.type, "CALL"), eq(s.activities.externalId, "CA-ooo-1")));
    expect(a).toMatchObject({ contactId, callStatus: "answered", durationSeconds: 184, subject: "Inbound call" });
    expect(a.summary).toContain("mold in bathroom");
    expect(a.nextSteps).toEqual(["Send proposal", "Schedule inspection"]);
    const steps = await t.db.select().from(s.tasks).where(eq(s.tasks.source, "QUO_NEXT_STEP"));
    expect(steps.map((x) => x.title).sort()).toEqual(["Schedule inspection", "Send proposal"]);
  });

  it("stores call transcripts", async () => {
    await deliver({
      id: "EVt",
      type: "call.transcript.completed",
      data: {
        resource: { callId: "CA-ooo-1", processingStatus: "completed", dialogue: [{ identifier: "+17185550100", content: "Hi, it's Pat." }, { userId: "US1", content: "Hi Pat!" }] },
        context: { phoneNumberId: LINE_PN },
      },
    });
    const [a] = await t.db.select().from(s.activities).where(eq(s.activities.externalId, "CA-ooo-1"));
    expect(a.transcript).toBe("+17185550100: Hi, it's Pat.\nESS: Hi Pat!");
    expect(a.summary).toContain("mold"); // untouched
  });

  it("missed call with auto-send OFF → draft text-back + approval task, not sent", async () => {
    await deliver(callEvent("CA-missed-1", "unanswered", "+17185550100"));
    const drafts = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.source, "MISSED_CALL"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "DRAFT", toAddress: "+17185550100", channel: "SMS" });
    expect(drafts[0].body).toMatch(/sorry we missed your call|office is closed/);
    const [task] = await t.db.select().from(s.tasks).where(sql`${s.tasks.title} like 'Approve missed-call text%'`);
    expect(task).toBeTruthy();
  });

  it("repeat missed calls from the same number within 24h don't queue a second text", async () => {
    await deliver(callEvent("CA-missed-2", "unanswered", "+17185550100"));
    const drafts = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.source, "MISSED_CALL"));
    expect(drafts).toHaveLength(1);
  });

  it("missed call with auto-send ON → sent through Quo after commit", async () => {
    await t.db.update(s.settings).set({ autoSendSms: true });
    const sendSms = vi.fn(async () => ({ id: "AC-sent-1" }));
    const { handleQuoDelivery } = await import("@/lib/comms/quo-webhook");
    const out = await handleQuoDelivery(`msg_${randomUUID()}`, callEvent("CA-missed-3", "unanswered", "+16465550111"), t.db, {
      quo: { sendSms } as never,
      mail: null,
    });
    expect(out).toMatchObject({ ok: true });
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ from: LINE_PN, to: "+16465550111" }));
    const [msg] = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.toAddress, "+16465550111"));
    expect(msg).toMatchObject({ status: "SENT", externalId: "AC-sent-1", approvedBy: null });
    const [act] = await t.db.select().from(s.activities).where(eq(s.activities.externalId, "AC-sent-1"));
    expect(act).toMatchObject({ type: "SMS", direction: "OUTBOUND" });
    await t.db.update(s.settings).set({ autoSendSms: false });
  });

  it("AIRnyc-line texts are stored sealed (no plaintext)", async () => {
    await deliver(msgEvent("AC-airnyc-1", "This is Ana Lopez, my son's asthma is worse", "+17185550177", AIRNYC_PN));
    const { rows } = await t.pool.query(`select * from activities where external_id = 'AC-airnyc-1'`);
    expect(JSON.stringify(rows[0])).not.toContain("Ana Lopez");
    expect(rows[0].sensitive).toBe(true);
    expect(rows[0].sensitive_enc).toMatch(/^v1\./);
    const { rows: log } = await t.pool.query(`select payload from webhook_deliveries`);
    expect(JSON.stringify(log)).not.toContain("Ana Lopez");
  });

  it("unhandled event types are acknowledged", async () => {
    const r = await deliver({ id: "EVx", type: "call.ringing", data: { resource: {} } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ handled: false });
  });
});
