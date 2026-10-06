/** AIRnyc over Microsoft Graph (SPEC §7.4 mode 4): tracker → cases, folder links, uploads. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import * as s from "@/db/schema";
import { getCase, encryptMember } from "@/lib/airnyc/cases";
import { syncTracker, uploadToCase } from "@/lib/airnyc/graph-sync";
import type { GraphClient } from "@/lib/integrations/microsoft-graph";
import { createUser, hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

const TRACKER = "https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents/ESS/Tracker.xlsx";
const ROOT = "https://airnyc.sharepoint.com/sites/Vendors/Shared%20Documents/ESS/Cases";

async function xlsx(rows: (string | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Tracker");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A fake Graph client: one tracker file, a root folder with case folders, and an upload sink. */
function fakeGraph(trackerRows: (string | null)[][], folders: { id: string; name: string }[]) {
  const uploads: { parent: string; name: string; size: number }[] = [];
  const created: string[] = [];
  const g = {
    itemByUrl: vi.fn(async (url: string) => (url === TRACKER ? { id: "f1", driveId: "drv1", name: "Tracker.xlsx", webUrl: TRACKER, file: {} } : { id: "root1", driveId: "drv1", name: "Cases", webUrl: ROOT, folder: {} })),
    download: vi.fn(async () => xlsx(trackerRows)),
    children: vi.fn(async () => folders.map((f) => ({ ...f, webUrl: `https://x/${f.id}`, folder: {} }))),
    createFolder: vi.fn(async (_d: string, _p: string, name: string) => (created.push(name), { id: `new-${created.length}`, name, webUrl: `https://x/new-${created.length}`, folder: {} })),
    upload: vi.fn(async (_d: string, parent: string, name: string, data: Buffer) => (uploads.push({ parent, name, size: data.length }), { id: "up1", name, webUrl: `https://x/up/${name}`, file: {} })),
  };
  return { g: g as unknown as GraphClient, uploads, created };
}

const HEAD = ["Case ID", "Member Name", "Address", "Case Manager", "Status"];
const cfg = { airnycTrackerUrl: TRACKER, airnycTrackerSheet: null, airnycTrackerColumns: { caseId: "Case ID", memberName: "Member Name", address: "Address", caseManagerName: "Case Manager", status: "Status" }, airnycRootFolderUrl: ROOT };

describe.skipIf(!hasTestDb)("AIRnyc Graph sync", () => {
  let t: TestDb;
  let owner: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    process.env.AIRNYC_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    t = await setupTestDb();
    owner = await createUser(t, "OWNER");
  });
  afterAll(async () => t?.close());

  it("creates cases from tracker rows, links folders by case ID, and skips rows without an ID", async () => {
    const { g } = fakeGraph(
      [HEAD, ["PHS_0148", "Ana Lopez", "120 West 44 Street", "Dee Park", "Referral received"], ["", "stray note", "", "", ""], ["Emblem_0022", "Luis Ortiz", "77 Pine St", "", "Scheduled"]],
      [{ id: "c1", name: "PHS_0148_Lopez_120 West 44 Street" }],
    );
    const r = await syncTracker(t.db, g, cfg);
    expect(r).toMatchObject({ rows: 3, created: 2, updated: 0, skipped: 1, foldersLinked: 1, warnings: [] });
    const [a] = await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.caseId, "PHS_0148"));
    expect(a).toMatchObject({ network: "PHS", trackerRow: 2, trackerStatus: "Referral received", caseManagerName: "Dee Park", sharepointItemId: "c1", sharepointDriveId: "drv1", sharepointFolderUrl: "https://x/c1" });
    expect(a.memberNameEnc).not.toContain("Ana"); // still sealed at rest
    expect((await getCase(t.db, owner.id, a.id))!.memberName).toBe("Ana Lopez");
    const [b] = await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.caseId, "EMBLEM_0022"));
    expect(b.sharepointItemId).toBeNull();
  });

  it("re-syncs: tracker-owned fields follow the tracker, CRM-owned fields and VA corrections stay", async () => {
    await t.db.update(s.airnycCases).set({ stage: "MEMBER_CONTACTED", qcStatus: "SUBMITTED", ...encryptMember({ memberName: "Ana M. Lopez" }) }).where(eq(s.airnycCases.caseId, "PHS_0148"));
    const { g } = fakeGraph([HEAD, ["PHS_0148", "Ana Lopez", "120 West 44 Street", "Sam Reyes", "Assessment scheduled"], ["Emblem_0022", "Luis Ortiz", "77 Pine St", "", "Scheduled"]], [
      { id: "c1", name: "PHS_0148_Lopez" },
      { id: "c2", name: "Emblem_0022" },
    ]);
    const r = await syncTracker(t.db, g, cfg);
    expect(r).toMatchObject({ created: 0, updated: 2, foldersLinked: 1 });
    const kase = (await getCase(t.db, owner.id, (await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.caseId, "PHS_0148")))[0].id))!;
    expect(kase).toMatchObject({ stage: "MEMBER_CONTACTED", qcStatus: "SUBMITTED", caseManagerName: "Sam Reyes", trackerStatus: "Assessment scheduled", memberName: "Ana M. Lopez" });
    const [b] = await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.caseId, "EMBLEM_0022"));
    expect(b.sharepointItemId).toBe("c2");
    // A second identical run changes nothing.
    expect((await syncTracker(t.db, g, cfg)).updated).toBe(0);
  });

  it("warns when a mapped column disappears and when folders can't be listed, without failing", async () => {
    const { g } = fakeGraph([["Case ID", "Member Name"], ["SIPPS_7", "Pat Q"]], []);
    (g.children as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Microsoft 403 accessDenied"));
    const r = await syncTracker(t.db, g, cfg);
    expect(r.warnings.join(" ")).toMatch(/Columns not found.*Address.*Case Manager.*Status/);
    expect(r.warnings.join(" ")).toMatch(/Couldn't list case folders: Microsoft 403/);
    expect(r.created).toBe(1);
  });

  it("uploads into the linked folder, or creates {CASE_ID}_{LastName}_{Address} under the root first", async () => {
    const { g, uploads, created } = fakeGraph([HEAD], [{ id: "c1", name: "PHS_0148_Lopez" }]);
    const [linked] = await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.caseId, "PHS_0148"));
    const kase = (await getCase(t.db, owner.id, linked.id))!;
    const r1 = await uploadToCase(t.db, g, cfg, kase, { name: "report.pdf", data: Buffer.from("%PDF"), contentType: "application/pdf" }, owner.id);
    expect(r1.webUrl).toBe("https://x/up/report.pdf");
    expect(uploads).toEqual([{ parent: "c1", name: "report.pdf", size: 4 }]);

    const [unlinked] = await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.caseId, "SIPPS_7"));
    const k2 = (await getCase(t.db, owner.id, unlinked.id))!;
    await uploadToCase(t.db, g, cfg, k2, { name: "photos.zip", data: Buffer.from("zip"), contentType: "application/zip" }, owner.id);
    expect(created).toEqual(["SIPPS_7_Q_No address"]); // airnycFolderName fills a missing address
    expect(uploads.at(-1)).toMatchObject({ parent: "new-1", name: "photos.zip" });
    const [after] = await t.db.select().from(s.airnycCases).where(eq(s.airnycCases.id, unlinked.id));
    expect(after).toMatchObject({ sharepointItemId: "new-1", sharepointDriveId: "drv1", sharepointFolderUrl: "https://x/new-1" });
    const audit = await t.db.select().from(s.auditLog).where(eq(s.auditLog.entity, "sharepoint_upload"));
    expect(audit.map((a) => (a.detail as { file: string }).file).sort()).toEqual(["photos.zip", "report.pdf"]);
  });
});
