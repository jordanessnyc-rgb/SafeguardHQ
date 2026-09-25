/** Weekly Drive export (Phase 6c). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import * as s from "@/db/schema";
import { buildExport, csvField, KEEP, runWeeklyExport, toCsv } from "@/lib/backup/export";
import type { DriveClient } from "@/lib/integrations/google-drive";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

describe("CSV", () => {
  it("quotes, escapes and neutralises spreadsheet formulas but keeps negative numbers", () => {
    expect(csvField('He said "hi", then left')).toBe('"He said ""hi"", then left"');
    expect(csvField("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("-5.00")).toBe("-5.00");
    expect(csvField("-cmd")).toBe(`"'-cmd"`);
    expect(csvField(new Date("2026-09-27T06:00:00Z"))).toBe("2026-09-27T06:00:00.000Z");
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvField(null)).toBe("");
    expect(toCsv(["a", "b"], [{ a: 1, b: "x\ny" }])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});

describe.skipIf(!hasTestDb)("weekly export (database)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
    await t.db.insert(s.organizations).values({ name: "Parkview Realty", type: "MANAGEMENT_CO" });
    await t.db.insert(s.freshbooksConnection).values({ accountId: "a1", accessTokenEnc: "SECRET-ACCESS", refreshTokenEnc: "SECRET-REFRESH", expiresAt: new Date() });
  });
  afterAll(async () => t?.close());

  it("zips every table as CSV, leaving out credentials", async () => {
    const { zip, tables } = await buildExport(t.pool, new Date("2026-09-27T06:00:00Z"));
    const z = new PizZip(zip);
    expect(tables.organizations).toBe(1);
    expect(z.file("organizations.csv")!.asText()).toContain("Parkview Realty");
    expect(z.file("jobs.csv")).toBeTruthy();
    expect(z.file("freshbooks_connection.csv")).toBeNull();
    expect(Object.values(z.files).some((f) => !f.dir && f.asText().includes("SECRET-REFRESH"))).toBe(false);
    expect(z.file("README.txt")!.asText()).toContain("_enc");
  });

  it("uploads once per day and keeps the newest exports", async () => {
    const files = Array.from({ length: KEEP }, (_, i) => ({ id: `old${i}`, name: `ess-crm-export-2026-0${(i % 9) + 1}-01.zip`, mimeType: "application/zip", createdTime: "" }));
    const uploads: string[] = [];
    const trashed: string[] = [];
    const drive = {
      listByPrefix: async () => files,
      uploadToFolder: async (_f: string, name: string, data: Buffer) => (uploads.push(name), expect(data.length).toBeGreaterThan(100), "new1"),
      trash: async (id: string) => void trashed.push(id),
    } as unknown as DriveClient;
    const r = await runWeeklyExport(t.pool, drive, "folder", new Date("2026-09-27T06:00:00Z"));
    expect(r).toMatchObject({ name: "ess-crm-export-2026-09-27.zip", uploaded: true, trashed: 1 });
    expect(uploads).toEqual(["ess-crm-export-2026-09-27.zip"]);
    expect(trashed).toEqual([`old${KEEP - 1}`]); // the oldest one beyond the newest KEEP

    files.unshift({ id: "new1", name: "ess-crm-export-2026-09-27.zip", mimeType: "application/zip", createdTime: "" });
    files.pop();
    const again = await runWeeklyExport(t.pool, drive, "folder", new Date("2026-09-27T07:00:00Z"));
    expect(again.uploaded).toBe(false); // a retry the same day doesn't upload twice
    expect(uploads).toHaveLength(1);
  });
});
