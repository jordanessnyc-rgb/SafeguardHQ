import { describe, expect, it } from "vitest";
import { jobsHref, jobsView } from "@/lib/jobs/list-state";
import { jobNextStep, nextJobStage } from "@/lib/jobs/next-step";
import { parseFieldInput } from "@/lib/jobs/field-input";

describe("Jobs navigation", () => {
  it("opens a readable list by default, including dashboard stage links", () => {
    expect(jobsView({})).toBe("list");
    expect(jobsView({ stage: "LAB_PENDING" })).toBe("list");
  });
  it.each(["open", "closed", "all"])("switches a %s list to Board without carrying list-only filters", (status) => {
    const url = new URL(jobsHref({ view: "list", status, stage: "PAID", service: "LL152", stale: "1", sort: "days", mine: "1", q: "Queens", pipeline: "INSPECTION", page: 3 }, { view: "board" }), "https://crm.example.test");
    expect(jobsView(Object.fromEntries(url.searchParams))).toBe("board");
    expect(url.searchParams.get("mine")).toBe("1");
    expect(url.searchParams.get("q")).toBe("Queens");
    expect(url.searchParams.get("pipeline")).toBe("INSPECTION");
    for (const key of ["status", "stage", "service", "stale", "sort", "page"]) expect(url.searchParams.has(key)).toBe(false);
  });
  it("keeps assignment and active list filters across pagination", () => {
    const url = new URL(jobsHref({ view: "list", mine: "1", stage: "LEAD,QUALIFIED", service: "LL152", q: "47-58", sort: "days" }, { page: 2 }), "https://crm.example.test");
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: "list", mine: "1", stage: "LEAD,QUALIFIED", service: "LL152", q: "47-58", sort: "days", page: "2" });
  });
});

describe("Job completion and next task", () => {
  const stage = (key: string, position: number, isTerminal = false) => ({ key, name: key, position, isTerminal });
  const stages = [stage("CLOSED", 13, true), stage("PAID", 12), stage("LOST", 99, true), stage("NEXT_CYCLE_SCHEDULED", 14, true)];
  it("offers Close after Paid even when configuration is unordered", () => {
    expect(nextJobStage(stages, "PAID")?.key).toBe("CLOSED");
  });
  it("offers Close after the final agency response", () => {
    expect(nextJobStage([stage("AGENCY_RESPONSE", 7), stage("CLOSED", 8, true), stage("LOST", 99, true)], "AGENCY_RESPONSE")?.key).toBe("CLOSED");
  });
  it("does not advance completed, lost, or unknown stages", () => {
    for (const current of ["CLOSED", "LOST", "missing"]) expect(nextJobStage(stages, current)).toBeUndefined();
  });
  it("does not automatically choose Lost or Next cycle scheduled", () => {
    expect(nextJobStage(stages.filter((s) => s.key !== "CLOSED"), "PAID")).toBeUndefined();
  });
  it("guides scheduling to the calendar and never financial tabs for VAs", () => {
    expect(jobNextStep("SIGNED", true).calendar).toBe(true);
    for (const current of ["QUALIFIED", "DELIVERED", "INVOICED"]) expect(jobNextStep(current, false).tab).not.toBe("money");
  });
});

describe("Structured visit data", () => {
  it("preserves delimiter characters and existing string measurements", () => {
    const readings = [{ area: "Bathroom, west wall", moisture: "12.5", rh: "48", temp: "72", note: "north | west corner" }];
    expect(parseFieldInput({ areasJson: JSON.stringify(["Bathroom, west wall"]), readingsJson: JSON.stringify(readings), observations: "Visit notes" })).toEqual({ areas: ["Bathroom, west wall"], readings, observations: "Visit notes" });
  });
  it("supports clearing all readings and areas", () => {
    expect(parseFieldInput({ areasJson: "[]", readingsJson: "[]" })).toMatchObject({ areas: [], readings: [] });
  });
  it("continues accepting legacy forms", () => {
    expect(parseFieldInput({ areas: "Bathroom, Bedroom", readings: "Bathroom | 10 | 50 | 70 | Corner" })).toMatchObject({ areas: ["Bathroom", "Bedroom"], readings: [{ area: "Bathroom", moisture: "10", rh: "50", temp: "70", note: "Corner" }] });
  });
  it("rejects malformed or incorrectly shaped structured data", () => {
    expect(() => parseFieldInput({ areasJson: "[", readingsJson: "[]" })).toThrow("could not be read");
    expect(() => parseFieldInput({ areasJson: "[]", readingsJson: '[{"area":42}]' })).toThrow();
  });
});
