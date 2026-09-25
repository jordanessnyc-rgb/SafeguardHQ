import { describe, expect, it } from "vitest";
import { suggestJob } from "@/lib/queues";

const jobs = [
  { id: "a", jobNumber: "ESS-2026-0142", address: "31-15 Steinway St" },
  { id: "b", jobNumber: "ESS-2026-0131", address: "47-58 43rd Street" },
  { id: "c", jobNumber: "ESS-2026-0099", address: null },
];

describe("suggestJob (inbox review)", () => {
  it("prefers an exact job number, ignoring case and spaces", () => {
    expect(suggestJob([" ess-2026-0131 ", "31-15 Steinway St"], jobs)?.id).toBe("b");
  });
  it("falls back to an address that contains, or is contained in, a hint with a house number", () => {
    expect(suggestJob(["31-15 steinway"], jobs)?.id).toBe("a");
    expect(suggestJob(["Re: inspection at 47-58 43rd Street, Queens"], jobs)?.id).toBe("b");
  });
  it("never matches on words alone, short hints, or nothing", () => {
    expect(suggestJob(["Steinway"], jobs)).toBeUndefined();
    expect(suggestJob(["St", "43"], jobs)).toBeUndefined();
    expect(suggestJob([], jobs)).toBeUndefined();
    expect(suggestJob(undefined, jobs)).toBeUndefined();
  });
});
