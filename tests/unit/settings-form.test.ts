import { describe, expect, it } from "vitest";
import { isSettingsSection, parseSettingsSection } from "@/lib/settings/form";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("settings: one section per save", () => {
  it("only returns the section's own columns, so other settings are never overwritten", () => {
    // A stray digest field in the approvals form must not leak into the update.
    const out = parseSettingsSection("approvals", fd({ section: "approvals", autoSendSms: "on", invoicePaymentTermsDays: "45", digestTime: "07:00" }));
    expect(out).toEqual({ autoSendEmail: false, autoSendSms: true, autoCreateInvoice: false, holdReportUntilPaidDefault: false, invoicePaymentTermsDays: 45 });
  });

  it("saves an unchecked box in its own section as off", () => {
    expect(parseSettingsSection("airnyc", fd({ airnycMode: "MANUAL" }))).toEqual({ airnycAiAllowed: false, airnycMode: "MANUAL" });
  });

  it("parses digest recipients and rejects a bad email", () => {
    expect(parseSettingsSection("digest", fd({ digestEnabled: "on", digestRecipients: "a@x.test, b@x.test", digestTime: "07:30" }))).toEqual({
      digestEnabled: true,
      digestSmsEnabled: false,
      digestRecipients: ["a@x.test", "b@x.test"],
      digestTime: "07:30",
    });
    expect(() => parseSettingsSection("digest", fd({ digestRecipients: "not-an-email", digestTime: "07:30" }))).toThrow();
  });

  it("accepts a pasted Drive folder URL and a blank as none", () => {
    expect(parseSettingsSection("drive", fd({ driveJobsParentFolderId: "https://drive.google.com/drive/folders/abc-123_X?usp=sharing" }))).toEqual({
      driveJobsParentFolderId: "abc-123_X",
      driveAirnycParentFolderId: null,
      driveTemplateFolderId: null,
    });
  });

  it("builds business hours, with a missing open or close meaning closed", () => {
    const out = parseSettingsSection("hours", fd({ monOpen: "09:00", monClose: "17:00", tueOpen: "09:00" }));
    expect(out.businessHours).toMatchObject({ mon: { open: "09:00", close: "17:00" }, tue: null, sun: null });
    expect(Object.keys(out)).toEqual(["businessHours"]);
  });

  it("knows its section names", () => {
    expect(isSettingsSection("budget")).toBe(true);
    expect(isSettingsSection("toString")).toBe(false);
    expect(isSettingsSection(null)).toBe(false);
  });
});
