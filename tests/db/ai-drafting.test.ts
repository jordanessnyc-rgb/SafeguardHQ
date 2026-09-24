/** AI reply drafts (SPEC §9.2) and call extraction (SPEC §9.3), with a mocked Anthropic client. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { AnthropicLike } from "@/lib/ai/anthropic";
import { extractCall, extractPendingCalls, type CallExtract } from "@/lib/ai/call-extract";
import { draftReply, PRICING_RE } from "@/lib/ai/draft";
import { sealContent } from "@/lib/comms/sensitive";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "../helpers/db";

const fake = <T,>(output: T) => {
  const parse = vi.fn(async (_req: unknown) => ({ parsed_output: output, stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 300 } }));
  return { api: { messages: { parse } } as unknown as AnthropicLike, parse, sent: () => JSON.stringify(parse.mock.calls.at(-1)?.[0]) };
};

describe("pricing detector", () => {
  it("flags money talk, not ordinary words", () => {
    expect(PRICING_RE.test("The assessment is $450")).toBe(true);
    expect(PRICING_RE.test("I'll send you a quote tomorrow")).toBe(true);
    expect(PRICING_RE.test("We can come Tuesday at 10 to inspect the bathroom.")).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("AI reply drafts + call extraction (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  let contact: typeof s.contacts.$inferSelect;
  let job: typeof s.jobs.$inferSelect;

  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
    await t.db.insert(s.phoneLines).values({ quoPhoneNumberId: "PNMAIN", number: "+19293051232", label: "ESS main", lineKey: "ESS_MAIN" });
    await t.db.update(s.settings).set({ aiVoiceNotes: "Short sentences. Signs off 'Best, Jordan'." });
    [contact] = await t.db.insert(s.contacts).values({ firstName: "Pat", lastName: "Lee", phones: ["+17185550100"], emails: ["pat@example.com"] }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "420 CENTRAL PARK WEST", unit: "2E", borough: "Manhattan" }).returning();
    [job] = await t.db
      .insert(s.jobs)
      .values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "SCHEDULED", propertyId: prop.id, clientContactId: contact.id, scheduledAt: new Date("2026-09-29T14:00:00Z") })
      .returning();
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, quotedAmount: "650.00", lineItems: [{ description: "Mold assessment", quantity: 1, unitPrice: 650 }] });
  });
  afterAll(async () => t?.close());
  beforeEach(async () => {
    await t.db.update(s.settings).set({ airnycAiAllowed: false });
  });

  const inbound = async (v: Partial<typeof s.activities.$inferInsert>) =>
    (await t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", contactId: contact.id, fromAddress: "+17185550100", channelLine: "ESS_MAIN", body: "hi", occurredAt: new Date(), ...v }).returning())[0];

  it("drafts an SMS reply into the Outbox with job context, Jordan's style notes and no pricing", async () => {
    await inbound({ type: "SMS", direction: "OUTBOUND", body: "Confirmed for Tuesday 10am.", occurredAt: new Date(Date.now() - 3600_000) });
    const a = await inbound({ body: "Can the inspector check the closet too?" });
    const f = fake({ subject: null, body: "Yes — we'll check the closet on Tuesday.", missing_info: [], confidence: 0.9 });
    const r = await draftReply(t.db, a.id, { includePricing: false, requesterRole: "VA" }, f.api);
    expect(r).toMatchObject({ status: "drafted", containsPricing: false });
    const sent = f.sent();
    expect(sent).toContain("JOB ESS-");
    expect(sent).toContain("420 CENTRAL PARK WEST, Apt 2E");
    expect(sent).toContain("Signs off 'Best, Jordan'");
    expect(sent).toContain("Confirmed for Tuesday 10am.");
    expect(sent).toContain("[REPLY TO THIS]");
    expect(sent).not.toContain("650"); // no prices unless the owner asks
    expect(sent).toContain("claude-sonnet-5");
    const [d] = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.id, (r as { outboundId: string }).outboundId));
    expect(d).toMatchObject({ status: "DRAFT", source: "AI_DRAFT", channel: "SMS", toAddress: "+17185550100", jobId: job.id, replyToActivityId: a.id, containsPricing: false });
    expect(await va.as((tx) => tx.select().from(s.outboundMessages).where(eq(s.outboundMessages.id, d.id)))).toHaveLength(1);
  });

  it("a VA can't pull prices in; a draft that mentions money anyway becomes owner-only", async () => {
    const a = await inbound({ body: "How much will this be?" });
    const f = fake({ subject: null, body: "The assessment is $650.", missing_info: [], confidence: 0.8 });
    const r = await draftReply(t.db, a.id, { includePricing: true, requesterRole: "VA" }, f.api);
    expect(f.sent()).not.toContain("Quoted total");
    expect(r).toMatchObject({ status: "drafted", containsPricing: true });
    const id = (r as { outboundId: string }).outboundId;
    expect(await va.as((tx) => tx.select().from(s.outboundMessages).where(eq(s.outboundMessages.id, id)))).toHaveLength(0);
    expect(await owner.as((tx) => tx.select().from(s.outboundMessages).where(eq(s.outboundMessages.id, id)))).toHaveLength(1);
  });

  it("the owner can include the quote; the draft is owner-only", async () => {
    const a = await inbound({ body: "What's the total?" });
    const f = fake({ subject: null, body: "Total is $650 as quoted.", missing_info: [], confidence: 0.9 });
    const r = await draftReply(t.db, a.id, { includePricing: true, requesterRole: "OWNER" }, f.api);
    expect(f.sent()).toContain("Quoted total: $650.00");
    expect(r).toMatchObject({ containsPricing: true });
  });

  it("email replies thread to the original and come from the default address", async () => {
    const a = await inbound({ type: "EMAIL_IN", fromAddress: "pat@example.com", subject: "Access", body: "Super has keys", externalId: "<m1@example.com>" });
    const f = fake({ subject: "Re: Access", body: "Thanks Pat.\n\nJordan Adhami, Environmental Safeguard Solutions", missing_info: ["[inspection date]"], confidence: 0.7 });
    const r = await draftReply(t.db, a.id, { includePricing: false, requesterRole: "OWNER" }, f.api);
    expect(r).toMatchObject({ status: "drafted", missingInfo: ["[inspection date]"] });
    const [d] = await t.db.select().from(s.outboundMessages).where(eq(s.outboundMessages.id, (r as { outboundId: string }).outboundId));
    expect(d).toMatchObject({ channel: "EMAIL", toAddress: "pat@example.com", subject: "Re: Access", inReplyTo: "<m1@example.com>", fromEmail: "sales@ess-nyc.com" });
  });

  it("AIRnyc messages are blocked (never decrypted or sent) while AIRnyc AI is off", async () => {
    const a = await inbound({ ...sealContent({ body: "Ana Lopez PHS_0148 asks about mold" }) });
    const f = fake({ subject: null, body: "x", missing_info: [], confidence: 1 });
    const r = await draftReply(t.db, a.id, { includePricing: false, requesterRole: "OWNER" }, f.api);
    expect(r.status).toBe("blocked");
    expect(f.parse).not.toHaveBeenCalled();

    // Allowed, but from an unknown sender with no case: nothing to redact with → still not sent.
    await t.db.update(s.settings).set({ airnycAiAllowed: true });
    const anon = (await t.db.insert(s.activities).values({ type: "SMS", direction: "INBOUND", fromAddress: "+13475550999", occurredAt: new Date(), ...sealContent({ body: "Ana Lopez here" }) }).returning())[0];
    expect((await draftReply(t.db, anon.id, { includePricing: false, requesterRole: "OWNER" }, f.api)).status).toBe("blocked");
    expect(f.parse).not.toHaveBeenCalled();
  });

  const call = async (v: Partial<typeof s.activities.$inferInsert>) =>
    (await t.db.insert(s.activities).values({ type: "CALL", direction: "INBOUND", externalId: `AC${randomBytes(4).toString("hex")}`, occurredAt: new Date(), ...v }).returning())[0];
  const extract = (x: Partial<CallExtract>): CallExtract => ({
    caller_first_name: null,
    caller_last_name: null,
    caller_email: null,
    address: null,
    service_code: null,
    urgency: "NORMAL",
    follow_ups: [],
    summary: "call",
    ...x,
  });

  it("call extraction: follow-ups become tasks once; blanks on the contact are filled, never overwritten", async () => {
    const [blank] = await t.db.insert(s.contacts).values({ phones: ["+13475550111"], source: "QUO" }).returning();
    const c = await call({ contactId: blank.id, transcript: "Caller: Hi, this is Dana Ortiz...", nextSteps: ["Send quote"] });
    const f = fake(
      extract({
        caller_first_name: "Dana",
        caller_last_name: "Ortiz",
        caller_email: "Dana@Example.com",
        address: "55 Water St, Brooklyn",
        service_code: "LL152",
        follow_ups: [{ title: "Call back with availability", due_in_days: 2 }],
      }),
    );
    expect(await extractPendingCalls(t.db, 10, f.api)).toBe(1);
    expect(f.sent()).toContain("ALREADY CAPTURED (Quo next steps):\\n- Send quote");
    expect(f.sent()).toContain("claude-haiku-4-5");
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.contactId, blank.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Call back with availability — Dana Ortiz", source: "CALL_AI" });
    expect(tasks[0].description).toContain("Address: 55 Water St, Brooklyn");
    const [ct] = await t.db.select().from(s.contacts).where(eq(s.contacts.id, blank.id));
    expect(ct).toMatchObject({ firstName: "Dana", lastName: "Ortiz", emails: ["dana@example.com"] });
    const [row] = await t.db.select().from(s.activities).where(eq(s.activities.id, c.id));
    expect((row.aiClassification as { extraction: CallExtract }).extraction.service_code).toBe("LL152");

    expect(await extractPendingCalls(t.db, 10, f.api)).toBe(0); // once only
    await call({ contactId: blank.id, transcript: "old call", occurredAt: new Date(Date.now() - 5 * 86_400_000) });
    expect(await extractPendingCalls(t.db, 10, f.api)).toBe(0); // older than 3 days: left alone
    expect(await extractCall(t.db, row, f.api)).toBe("skipped");

    // Existing names are kept.
    const c2 = await call({ contactId: contact.id, transcript: "..." });
    await extractCall(t.db, c2, fake(extract({ caller_first_name: "Patricia", caller_email: "other@x.com" })).api);
    const [pat] = await t.db.select().from(s.contacts).where(eq(s.contacts.id, contact.id));
    expect(pat).toMatchObject({ firstName: "Pat", emails: ["pat@example.com"] });
  });

  it("sealed AIRnyc transcripts: blocked while AIRnyc AI is off; when allowed, tasks carry no call content", async () => {
    const sealed = sealContent({ transcript: "Caller: Ana Lopez, member PHS_0148, mold in bedroom" });
    const off = await call({ ...sealed, aiClassification: { sealedTranscript: true } });
    const f1 = fake(extract({}));
    expect(await extractCall(t.db, off, f1.api)).toBe("blocked");
    expect(f1.parse).not.toHaveBeenCalled();

    await t.db.update(s.settings).set({ airnycAiAllowed: true });
    const unknown = await call({ ...sealed, aiClassification: { sealedTranscript: true } });
    const f0 = fake(extract({}));
    expect(await extractCall(t.db, unknown, f0.api)).toBe("blocked"); // nobody's name is known → can't redact → not sent
    expect(f0.parse).not.toHaveBeenCalled();

    const [member] = await t.db.insert(s.contacts).values({ firstName: "Ana", lastName: "Lopez", phones: ["+13475550222"] }).returning();
    const on = await call({ ...sealed, contactId: member.id, aiClassification: { sealedTranscript: true } });
    const f2 = fake(extract({ address: "1 Main St", follow_ups: [{ title: "Schedule the assessment", due_in_days: 1 }] }));
    expect(await extractCall(t.db, on, f2.api)).toBe("extracted");
    expect(f2.sent()).not.toContain("Ana Lopez");
    const [task] = await t.db.select().from(s.tasks).where(eq(s.tasks.title, "Schedule the assessment (AIRnyc call)"));
    expect(task.description).not.toContain("1 Main St");
    const [row] = await t.db.select().from(s.activities).where(eq(s.activities.id, on.id));
    expect(JSON.stringify(row.aiClassification)).not.toContain("1 Main St");
  });
});
