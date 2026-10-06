/**
 * AIRnyc ↔ SharePoint over Microsoft Graph (SPEC §7.4 mode 4).
 *  - syncTracker: download the tracker workbook, create/update cases by case ID, remember each row,
 *    and link every case to its folder under the AIRnyc root folder (a folder whose name contains the
 *    case ID). Read-only toward SharePoint: the CRM never edits the tracker.
 *  - uploadToCase: put one of the case's CRM documents into that folder. Only ever started by a
 *    person clicking "Send to AIRnyc" (CLAUDE.md rule 6), and written to the audit log.
 */
import { eq, inArray } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import type { GraphClient } from "@/lib/integrations/microsoft-graph";
import { airnycFolderName } from "@/lib/integrations/google-drive";
import { encryptMember, lastNameOf, networkFromCaseId } from "./cases";
import { readTracker, rowsToCases, type ColumnMap, type TrackerCase } from "./tracker";

type Conn = Db | Tx;

export type SyncResult = { rows: number; created: number; updated: number; skipped: number; foldersLinked: number; warnings: string[] };

type GraphSettings = { airnycTrackerUrl: string | null; airnycTrackerSheet: string | null; airnycTrackerColumns: Record<string, string> | null; airnycRootFolderUrl: string | null };

/** Case folders under the root, keyed by case ID found in the folder name (upper-cased). */
async function caseFolders(graph: GraphClient, rootUrl: string): Promise<{ driveId: string; rootId: string; byCaseId: Map<string, { id: string; webUrl: string }> }> {
  const root = await graph.itemByUrl(rootUrl);
  if (!root.folder) throw new Error("The AIRnyc root folder address points at a file, not a folder.");
  const byCaseId = new Map<string, { id: string; webUrl: string }>();
  for (const child of await graph.children(root.driveId, root.id)) {
    if (!child.folder) continue;
    // Folder names look like "PHS_0148_Lopez_120 West 44 Street" (SPEC §6.4) or just "PHS_0148".
    // Not \b: "_" is a word character, so "PHS_0148_Lopez" would never match.
    const m = child.name.match(/(?<![A-Z0-9])(PHS|EMBLEM|SIPPS)[_-]\d{2,6}(?![0-9])/i);
    if (m) byCaseId.set(m[0].toUpperCase().replace("-", "_"), { id: child.id, webUrl: child.webUrl });
  }
  return { driveId: root.driveId, rootId: root.id, byCaseId };
}

export async function syncTracker(conn: Conn, graph: GraphClient, cfg: GraphSettings, now = new Date()): Promise<SyncResult> {
  if (!cfg.airnycTrackerUrl) throw new Error("Set the tracker address in Settings → AIRnyc.");
  const map = (cfg.airnycTrackerColumns ?? {}) as ColumnMap;
  if (!map.caseId) throw new Error("Choose which tracker column holds the case ID (Settings → AIRnyc).");
  const warnings: string[] = [];

  const tracker = await graph.itemByUrl(cfg.airnycTrackerUrl);
  const sheet = await readTracker(await graph.download(tracker.driveId, tracker.id), cfg.airnycTrackerSheet);
  const missing = Object.values(map).filter((h) => h && !sheet.headers.includes(h));
  if (missing.length) warnings.push(`Columns not found in the tracker any more: ${missing.join(", ")}.`);
  const { cases, skipped } = rowsToCases(sheet.rows, map);

  const folders = cfg.airnycRootFolderUrl ? await caseFolders(graph, cfg.airnycRootFolderUrl).catch((e) => (warnings.push(`Couldn't list case folders: ${(e as Error).message}`), null)) : null;

  const ids = cases.map((c) => c.caseId.toUpperCase());
  const existing = ids.length ? await conn.select().from(s.airnycCases).where(inArray(s.airnycCases.caseId, ids)) : [];
  const byId = new Map(existing.map((e) => [e.caseId.toUpperCase(), e]));
  let created = 0;
  let updated = 0;
  let foldersLinked = 0;

  for (const c of cases) {
    const key = c.caseId.toUpperCase();
    const folder = folders?.byCaseId.get(key.replace("-", "_"));
    const link = folder ? { sharepointFolderUrl: folder.webUrl, sharepointDriveId: folders!.driveId, sharepointItemId: folder.id } : {};
    const fromTracker = trackerFields(c);
    const row = byId.get(key);
    if (!row) {
      await conn.insert(s.airnycCases).values({
        caseId: key,
        network: networkFromCaseId(key),
        ...fromTracker,
        ...encryptMember({ memberName: c.memberName, guardianName: c.guardianName, memberPhone: c.memberPhone, address: c.address }),
        ...link,
        trackerSyncedAt: now,
      });
      created++;
      if (folder) foldersLinked++;
      continue;
    }
    // Tracker fields are AIRnyc's to change; the CRM keeps its own stage, job, consents and QC status.
    const patch: Partial<typeof s.airnycCases.$inferInsert> = { ...fromTracker, trackerSyncedAt: now };
    // Member details only fill blanks (the VA may have corrected them in the CRM).
    const member: Parameters<typeof encryptMember>[0] = {};
    if (!row.memberNameEnc && c.memberName) member.memberName = c.memberName;
    if (!row.guardianNameEnc && c.guardianName) member.guardianName = c.guardianName;
    if (!row.memberPhoneEnc && c.memberPhone) member.memberPhone = c.memberPhone;
    if (!row.addressEnc && c.address) member.address = c.address;
    Object.assign(patch, encryptMember(member));
    if (folder && row.sharepointItemId !== folder.id) {
      Object.assign(patch, link);
      foldersLinked++;
    }
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => k !== "trackerSyncedAt" && JSON.stringify(patch[k]) !== JSON.stringify(row[k as keyof typeof row]));
    await conn.update(s.airnycCases).set(patch).where(eq(s.airnycCases.id, row.id));
    if (changed) updated++;
  }
  return { rows: sheet.rows.length, created, updated, skipped, foldersLinked, warnings };
}

function trackerFields(c: TrackerCase) {
  return {
    trackerRow: c.row,
    trackerStatus: c.status,
    caseManagerName: c.caseManagerName,
    caseManagerEmail: c.caseManagerEmail,
    approvedServices: c.approvedServices,
    qcReviewer: c.qcReviewer,
    ...(c.isNycha === null ? {} : { isNycha: c.isNycha }),
  };
}

/** Records the sync outcome on settings so the AIRnyc settings page can show it. */
export async function recordSync(conn: Conn, result: SyncResult | Error, at = new Date()) {
  await conn
    .update(s.settings)
    .set(result instanceof Error ? { airnycGraphError: result.message.slice(0, 500), airnycGraphSyncedAt: at } : { airnycGraphError: result.warnings.join(" ") || null, airnycGraphSyncedAt: at })
    .where(eq(s.settings.id, 1));
}

/**
 * Uploads a document's bytes into the case's SharePoint folder, creating the folder under the root
 * ({CASE_ID}_{LastName}_{Address}) when the case has none yet. Returns the file's SharePoint link.
 */
export async function uploadToCase(
  conn: Conn,
  graph: GraphClient,
  cfg: Pick<GraphSettings, "airnycRootFolderUrl">,
  kase: { id: string; caseId: string; memberName: string | null; address: string | null; sharepointDriveId: string | null; sharepointItemId: string | null },
  file: { name: string; data: Buffer; contentType: string },
  actor: string,
): Promise<{ webUrl: string; folderUrl: string }> {
  let driveId = kase.sharepointDriveId;
  let folderId = kase.sharepointItemId;
  let folderUrl: string | null = null;
  if (!driveId || !folderId) {
    if (!cfg.airnycRootFolderUrl) throw new Error("This case has no SharePoint folder, and no AIRnyc root folder is set in Settings to create one in.");
    const { driveId: d, rootId, byCaseId } = await caseFolders(graph, cfg.airnycRootFolderUrl);
    const found = byCaseId.get(kase.caseId.toUpperCase());
    const folder = found ?? (await graph.createFolder(d, rootId, airnycFolderName(kase.caseId, lastNameOf(kase.memberName), kase.address)));
    driveId = d;
    folderId = folder.id;
    folderUrl = folder.webUrl;
    await conn.update(s.airnycCases).set({ sharepointDriveId: d, sharepointItemId: folder.id, sharepointFolderUrl: folder.webUrl }).where(eq(s.airnycCases.id, kase.id));
  }
  const item = await graph.upload(driveId, folderId, file.name, file.data, file.contentType);
  await conn.insert(s.auditLog).values({ actor, action: "INSERT", entity: "sharepoint_upload", entityId: kase.id, detail: { caseId: kase.caseId, file: file.name, webUrl: item.webUrl } });
  return { webUrl: item.webUrl, folderUrl: folderUrl ?? "" };
}
