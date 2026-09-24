/** Bid ingestion: NYC City Record (Open Data) + bid alert emails (SPEC §8). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { AnthropicLike } from "@/lib/ai/anthropic";
import { bidTypeFrom, bidsFromPendingEmails, ingestCityRecord, keywordMatcher } from "@/lib/bids/ingest";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

describe("matching helpers", () => {
  it("keywords match on word boundaries", () => {
    const m = keywordMatcher(["lead", "industrial hygiene", "gas piping"]);
    expect(m("Lead-Based Paint Inspections")).toBe("lead");
    expect(m("Leadership training services")).toBeNull();
    expect(m("Industrial  Hygiene Svcs at Various Park Locations")).toBe("industrial hygiene");
    expect(m("Gas-piping inspections LL152")).toBe("gas piping");
  });
  it("maps selection methods to bid types", () => {
    expect(bidTypeFrom("Competitive Sealed Proposals/Pre-Qualified List")).toBe("RFP");
    expect(bidTypeFrom("Competitive Sealed Bid")).toBe("RFB");
    expect(bidTypeFrom("Small Purchase — Request for Quotation")).toBe("RFQ");
  });
});

describe.skipIf(!hasTestDb)("bid ingestion (database)", () => {
  let t: TestDb;
  const now = new Date("2026-09-24T15:00:00Z");
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  it("pulls City Record solicitations matching keywords; skips closed/irrelevant; dedupes on re-run", async () => {
    const rows = [
      { request_id: "20260915101", short_title: "IDIQ Contract for Asbestos Investigation and Testing Services", agency_name: "NYC Housing Authority", pin: "450000123", selection_method_description: "Competitive Sealed Proposals", due_date: "2026-10-15T14:00:00.000", start_date: "2026-09-15T00:00:00.000", contact_name: "J. Buyer", email: "buyer@nycha.nyc.gov", additional_description_1: "Asbestos surveys in NYCHA developments." },
      { request_id: "20260910102", short_title: "Leadership Coaching Services", agency_name: "DCAS", due_date: "2026-10-20T14:00:00.000", start_date: "2026-09-10T00:00:00.000" }, // "lead" only inside "Leadership"
      { request_id: "20260901103", short_title: "Lead Paint Inspections", agency_name: "HPD", due_date: "2026-09-20T14:00:00.000", start_date: "2026-09-01T00:00:00.000" }, // closed
    ];
    const urls: string[] = [];
    const fake = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      urls.push(`${u.pathname} ${u.searchParams.get("$where")}`);
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await ingestCityRecord(t.db, { fetch: fake, now })).toEqual({ fetched: 3, matched: 2, inserted: 1 });
    expect(urls[0]).toContain("/resource/dg92-zbpx.json");
    expect(urls[0]).toContain("section_name='Procurement' AND type_of_notice_description='Solicitation' AND start_date >= '2026-09-10T00:00:00'");
    expect(urls[0]).toContain("upper(short_title) like '%ASBESTOS%'");

    const [b] = await t.db.select().from(s.bids).where(eq(s.bids.externalId, "20260915101"));
    expect(b).toMatchObject({ source: "CITY_RECORD", status: "WATCHING", type: "RFP", agency: "NYC Housing Authority", solicitationNumber: "450000123", buyerEmail: "buyer@nycha.nyc.gov", scope: "Asbestos surveys in NYCHA developments." });
    expect(b.dueAt!.toISOString()).toBe("2026-10-15T18:00:00.000Z");
    expect(await ingestCityRecord(t.db, { fetch: fake, now })).toMatchObject({ inserted: 0 });
  });

  it("bid alert emails: one email can list several; only relevant, open ones become bids; each email once", async () => {
    const [a] = await t.db
      .insert(s.activities)
      .values({ type: "EMAIL_IN", direction: "INBOUND", fromAddress: "noreply@nyscr.ny.gov", subject: "NYSCR daily e-Alert", body: "3 new ads...", triageCategory: "BID_NOTICE", triageStatus: "AUTO", occurredAt: new Date("2026-09-24T12:00:00Z") })
      .returning();
    const parse = vi.fn(async (_req: unknown) => ({
      parsed_output: {
        solicitations: [
          { title: "Environmental Testing Services", agency: "Suffolk County Community College", solicitation_number: "B26-006", due_at: "2026-10-09T15:00", url: "https://www.nyscr.ny.gov/business/ad/123", source: "NYSCR", relevant: true },
          { title: "Snow removal", agency: "Town of X", solicitation_number: "SR-1", due_at: "2026-10-01T12:00", url: null, source: "NYSCR", relevant: false },
          { title: "Mold remediation oversight", agency: "DASNY", solicitation_number: null, due_at: "2026-09-01T12:00", url: null, source: "NYSCR", relevant: true }, // already closed
        ],
      },
      stop_reason: "end_turn",
      usage: { input_tokens: 3000, output_tokens: 300 },
    }));
    const api = { messages: { parse } } as unknown as AnthropicLike;
    expect(await bidsFromPendingEmails(t.db, api, now)).toBe(1);
    expect(await bidsFromPendingEmails(t.db, api, now)).toBe(0); // each email once
    expect(parse).toHaveBeenCalledTimes(1);
    const [b] = await t.db.select().from(s.bids).where(eq(s.bids.externalId, "B26-006"));
    expect(b).toMatchObject({ source: "NYSCR", title: "Environmental Testing Services", sourceUrl: "https://www.nyscr.ny.gov/business/ad/123", status: "WATCHING" });
    const [act] = await t.db.select().from(s.activities).where(eq(s.activities.id, a.id));
    expect(act.bidId).toBe(b.id);
  });
});
