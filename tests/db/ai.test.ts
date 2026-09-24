/** AI layer (SPEC §9.1, §9.4, §9.8): redaction, the AIRnyc block, cost cap, logging, triage. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { redact, unredact } from "@/lib/ai/redact";
import { guardedParse, type AnthropicLike } from "@/lib/ai/anthropic";
import { TriageSchema, triageActivity, type Triage } from "@/lib/ai/classify";
import { sealContent } from "@/lib/comms/sensitive";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

describe("redaction", () => {
  const text =
    "Ana Lopez (DOB 03/14/2015) at 22 Stagg St Apt 3 called from (718) 555-0177, email ana.lopez@gmail.com, case PHS_0148. Mrs. Lopez says mold is back.";
  it("replaces names, DOBs, addresses, phones, emails, and case IDs", () => {
    const { text: out, map } = redact(text, ["Ana Lopez"]);
    for (const secret of ["Ana", "Lopez", "03/14/2015", "22 Stagg St", "555-0177", "ana.lopez@gmail.com", "PHS_0148"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("mold is back");
    expect(map.size).toBeGreaterThanOrEqual(6);
  });
  it("round-trips through unredact, including inside nested output", () => {
    const { text: out, map } = redact(text, ["Ana Lopez"]);
    expect(unredact(out, map)).toBe(text);
    const tok = [...map.entries()].find(([, v]) => v === "Ana Lopez")![0];
    expect(unredact({ summary: `${tok} reports mold`, hints: [tok] }, map)).toEqual({ summary: "Ana Lopez reports mold", hints: ["Ana Lopez"] });
  });
  it("reuses the same token for repeated values", () => {
    const { text: out } = redact("Call 718-555-0177 or 718-555-0177", []);
    expect(out).toBe("Call [PHONE_1] or [PHONE_1]");
  });
});

const fakeApi = (output: Partial<Triage>) => {
  const parse = vi.fn(async (_req: unknown) => ({
    parsed_output: { category: "OTHER", confidence: 0.5, job_match_hints: [], address: null, service_code: null, urgency: "NORMAL", summary: "x", ...output },
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 80 },
  }));
  return { api: { messages: { parse } } as unknown as AnthropicLike, parse };
};

describe.skipIf(!hasTestDb)("guarded AI calls + triage", () => {
  let t: TestDb;
  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());
  beforeEach(async () => {
    await t.db.update(s.settings).set({ airnycAiAllowed: false, aiMonthlyCostCapUsd: null });
  });

  const base = { feature: "TEST", model: "claude-haiku-4-5", system: "sys", schema: TriageSchema };

  it("blocks AIRnyc-linked payloads while airnyc_ai_allowed=false, and logs the attempt", async () => {
    const { api, parse } = fakeApi({});
    const res = await guardedParse(t.db, { ...base, userText: "Ana Lopez PHS_0148", airnycLinked: true }, api);
    expect(res.status).toBe("blocked");
    expect(parse).not.toHaveBeenCalled();
    const [log] = await t.db.select().from(s.aiCalls).where(eq(s.aiCalls.feature, "TEST"));
    expect(log).toMatchObject({ blocked: "airnyc_ai_allowed=false", airnycLinked: true });
  });

  it("when allowed, sends only redacted text and un-redacts the answer; logs tokens + cost", async () => {
    await t.db.update(s.settings).set({ airnycAiAllowed: true });
    const { api, parse } = fakeApi({ summary: "[NAME_1] reports mold" });
    const res = await guardedParse(t.db, { ...base, feature: "TEST2", userText: "Ana Lopez reports mold", airnycLinked: true, knownNames: ["Ana Lopez"] }, api);
    const sent = JSON.stringify(parse.mock.calls[0][0]);
    expect(sent).not.toContain("Ana");
    expect(res.status === "ok" && res.output.summary).toBe("Ana Lopez reports mold");
    const [log] = await t.db.select().from(s.aiCalls).where(eq(s.aiCalls.feature, "TEST2"));
    expect(log).toMatchObject({ redacted: true, inputTokens: 1200, outputTokens: 80, costUsd: "0.00160" });
  });

  it("stops calling once the monthly cost cap is reached", async () => {
    await t.db.update(s.settings).set({ aiMonthlyCostCapUsd: "0.001" });
    const { api, parse } = fakeApi({});
    const res = await guardedParse(t.db, { ...base, userText: "hello", airnycLinked: false }, api);
    expect(res).toMatchObject({ status: "blocked" });
    expect(parse).not.toHaveBeenCalled();
  });

  const inbound = async (v: Partial<typeof s.activities.$inferInsert> = {}) =>
    (await t.db.insert(s.activities).values({ type: "EMAIL_IN", direction: "INBOUND", subject: "Quote?", body: "Need a mold inspection at 5 Main St", triageStatus: "PENDING", ...v }).returning())[0];

  it("confident NEW_LEAD → AUTO + a new-lead task", async () => {
    const a = await inbound();
    const { api } = fakeApi({ category: "NEW_LEAD", confidence: 0.93, summary: "Wants a mold inspection at 5 Main St", service_code: "MOLD_ASSESS" });
    expect(await t.db.transaction((tx) => triageActivity(tx, a, api))).toBe("AUTO");
    const [row] = await t.db.select().from(s.activities).where(eq(s.activities.id, a.id));
    expect(row).toMatchObject({ triageCategory: "NEW_LEAD", summary: "Wants a mold inspection at 5 Main St" });
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.source, "EMAIL_AI"));
    expect(tasks).toHaveLength(1);
  });

  it("low confidence → NEEDS_REVIEW (review queue)", async () => {
    const a = await inbound();
    const { api } = fakeApi({ category: "EXISTING_JOB", confidence: 0.4 });
    expect(await t.db.transaction((tx) => triageActivity(tx, a, api))).toBe("NEEDS_REVIEW");
  });

  it("EXISTING_JOB with a job-number hint files the message under that job", async () => {
    const [job] = await t.db.insert(s.jobs).values({ serviceCode: "LL152", pipelineKey: "INSPECTION", stage: "SCHEDULED" }).returning();
    const a = await inbound();
    const { api } = fakeApi({ category: "EXISTING_JOB", confidence: 0.9, job_match_hints: [`job ${job.jobNumber.toLowerCase()}`] });
    await t.db.transaction((tx) => triageActivity(tx, a, api));
    const [row] = await t.db.select().from(s.activities).where(eq(s.activities.id, a.id));
    expect(row.jobId).toBe(job.id);
  });

  it("sealed AIRnyc messages are BLOCKED without ever being decrypted", async () => {
    const a = await inbound({ ...sealContent({ subject: "PHS_0148", body: "Ana Lopez consent" }) });
    const { api, parse } = fakeApi({});
    expect(await t.db.transaction((tx) => triageActivity(tx, a, api))).toBe("BLOCKED");
    expect(parse).not.toHaveBeenCalled();
    const reads = await t.db.select().from(s.auditLog).where(eq(s.auditLog.entityId, a.id));
    expect(reads).toHaveLength(0);
  });
});
