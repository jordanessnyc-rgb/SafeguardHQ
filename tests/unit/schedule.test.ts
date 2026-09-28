import { describe, expect, it } from "vitest";
import { scheduleDays, shiftDay } from "@/lib/schedule/load";
import { durationLabel, stageAfterScheduling } from "@/lib/schedule/rules";

const INSPECTION = ["LEAD", "QUALIFIED", "PROPOSAL_SENT", "SIGNED", "SCHEDULED", "FIELD_COMPLETE", "CLOSED"].map((key, position) => ({ key, position, isTerminal: key === "CLOSED" }));
const AIRNYC = ["REFERRAL_RECEIVED", "MEMBER_CONTACTED", "CONSENT", "ASSESSMENT_SCHEDULED", "ASSESSMENT_DONE"].map((key, position) => ({ key, position, isTerminal: false }));

describe("schedule (7c)", () => {
  it("builds a Monday-start week in New York dates, or a single day", () => {
    expect(scheduleDays("2026-10-01", "week")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(scheduleDays("2026-09-28", "week")[0]).toBe("2026-09-28"); // a Monday stays put
    expect(scheduleDays("2026-10-04", "week")[0]).toBe("2026-09-28"); // Sunday belongs to the week before
    expect(scheduleDays("2026-10-01", "day")).toEqual(["2026-10-01"]);
    expect(shiftDay("2026-11-01", 7)).toBe("2026-11-08"); // across the DST change
  });
  it("moves a job to the scheduled stage only when that's the very next step", () => {
    expect(stageAfterScheduling(INSPECTION, "SIGNED")).toBe("SCHEDULED");
    expect(stageAfterScheduling(INSPECTION, "LEAD")).toBeNull(); // a site visit before a proposal stays a lead
    expect(stageAfterScheduling(INSPECTION, "SCHEDULED")).toBeNull();
    expect(stageAfterScheduling(AIRNYC, "CONSENT")).toBe("ASSESSMENT_SCHEDULED");
  });
  it("labels visit lengths plainly", () => {
    expect(durationLabel(30)).toBe("30 min");
    expect(durationLabel(90)).toBe("1h 30m");
    expect(durationLabel(120)).toBe("2h");
    expect(durationLabel(480)).toBe("Full day (8h)");
  });
});
