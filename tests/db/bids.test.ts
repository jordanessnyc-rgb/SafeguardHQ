/** Bids (SPEC §8) and AI-assisted go/no-go (SPEC §9.6), with a mocked Anthropic client. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { AnthropicLike } from "@/lib/ai/anthropic";
import { analyzeRfp } from "@/lib/bids/analyze";
import { buildDigest, renderDigestText } from "@/lib/money/digest";
import { createUser, hasTestDb, setupTestDb, type TestDb, type TestUser } from "./../helpers/db";

describe.skipIf(!hasTestDb)("bids + go/no-go (database)", () => {
  let t: TestDb;
  let owner: TestUser;
  let va: TestUser;
  const now = new Date("2026-09-24T15:00:00Z");
  const analysis = {
    title: "Mold assessment services — DOE buildings",
    agency: "NYC Department of Education",
    solicitation_number: "R1234",
    type: "RFP",
    questions_due: "2026-09-28T17:00",
    due_at: "2026-09-30T14:00",
    opening_at: null,
    site_visit_at: "2026-09-26T10:00",
    buyer_name: "A. Buyer",
    buyer_email: "buyer@schools.nyc.gov",
    buyer_phone: null,
    required_certs: ["NYS DOL Mold Assessor license", "NYS DOL Asbestos Handling License"],
    insurance_requirements: "GL $1M/$2M; professional liability $1M.",
    scope_summary: "On-call mold assessments in DOE buildings.",
    submission_requirements: ["Form A", "3 references"],
    checklist: [
      { item: "NYS DOL Mold Assessor license", status: "MET", note: "NYS Mold Assessor on file" },
      { item: "NYS DOL Asbestos Handling License", status: "GAP", note: "Not held" },
      { item: "Insurance limits", status: "UNKNOWN", note: "Confirm with broker" },
    ],
    recommendation: "REVIEW",
    summary: "Good fit for mold work; asbestos license gap.",
  };
  const fakeApi = () => {
    const parse = vi.fn(async (_req: unknown) => ({ parsed_output: analysis, stop_reason: "end_turn", usage: { input_tokens: 30000, output_tokens: 900 } }));
    return { api: { messages: { parse } } as unknown as AnthropicLike, parse };
  };

  beforeAll(async () => {
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
    va = await createUser(t, "VA");
  });
  afterAll(async () => t?.close());

  it("staff create and update bids; only the owner deletes; listings dedupe on (source, external id)", async () => {
    const [b] = await va.as((tx) => tx.insert(s.bids).values({ title: "Watching this one", source: "NYSCR", externalId: "NYSCR-1" }).returning());
    expect(b.status).toBe("WATCHING");
    await expect(va.as((tx) => tx.insert(s.bids).values({ title: "dupe", source: "NYSCR", externalId: "NYSCR-1" }))).rejects.toThrow();
    expect(await va.as((tx) => tx.delete(s.bids).where(eq(s.bids.id, b.id)).returning())).toHaveLength(0);
    expect(await owner.as((tx) => tx.delete(s.bids).where(eq(s.bids.id, b.id)).returning())).toHaveLength(1);
  });

  it("analyzes the RFP PDF against ESS credentials: fills empty fields, keeps manual ones, records gaps + deadline tasks", async () => {
    await t.db.update(s.credentials).set({ number: "MA-1", expiresAt: "2027-06-30" }).where(eq(s.credentials.name, "NYS Mold Assessor"));
    const [bid] = await t.db.insert(s.bids).values({ title: "Untitled bid", buyerName: "Entered By Hand" }).returning();
    const f = fakeApi();
    const r = await analyzeRfp(t.db, bid.id, Buffer.from("%PDF-1.7 rfp"), f.api, now);
    expect(r).toMatchObject({ status: "ok", goNoGo: { recommendation: "REVIEW" } });

    const req = f.parse.mock.calls[0][0] as { model: string; messages: { content: { type: string; source?: { media_type: string; data: string }; text?: string }[] }[] };
    expect(req.model).toBe("claude-sonnet-5");
    expect(req.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf", data: Buffer.from("%PDF-1.7 rfp").toString("base64") } });
    expect(req.messages[0].content[1].text).toContain("NYS Mold Assessor #MA-1 (NYS Department of Labor), expires 2027-06-30");

    const [b] = await t.db.select().from(s.bids).where(eq(s.bids.id, bid.id));
    expect(b).toMatchObject({
      title: "Mold assessment services — DOE buildings",
      agency: "NYC Department of Education",
      solicitationNumber: "R1234",
      type: "RFP",
      buyerName: "Entered By Hand", // never overwritten
      buyerEmail: "buyer@schools.nyc.gov",
      certGaps: ["NYS DOL Asbestos Handling License"],
      status: "GO_NO_GO",
      decision: null, // AI only recommends
    });
    expect(b.dueAt!.toISOString()).toBe("2026-09-30T18:00:00.000Z"); // 2 PM EDT
    const tasks = await t.db.select().from(s.tasks).where(eq(s.tasks.bidId, bid.id));
    expect(tasks.map((x) => x.title).sort()).toEqual(["Bid due — R1234", "Questions due — R1234", "Site visit — R1234"]);
    await analyzeRfp(t.db, bid.id, Buffer.from("%PDF-1.7 rfp"), fakeApi().api, now); // re-run: no duplicate tasks
    expect(await t.db.select().from(s.tasks).where(eq(s.tasks.bidId, bid.id))).toHaveLength(3);

    const d = await buildDigest(t.db, now);
    expect(d.bidsDue.map((x) => x.title)).toEqual(["Mold assessment services — DOE buildings"]);
    expect(renderDigestText(d).text).toContain("BIDS DUE WITHIN 7 DAYS (1)");
    expect(renderDigestText(d).text).toContain("AI: REVIEW");
  });
});
