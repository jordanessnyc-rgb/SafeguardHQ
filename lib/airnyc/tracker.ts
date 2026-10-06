/**
 * AIRnyc's tracker workbook → case rows (SPEC §7.4 mode 4). The workbook is downloaded from SharePoint
 * and read here with exceljs, because Graph's Excel API is delegated-only. Columns are matched by the
 * owner's saved mapping (Settings → AIRnyc), with a guess from the header names to start from.
 */
import ExcelJS from "exceljs";

/** Case fields a tracker column can feed. */
export const TRACKER_FIELDS = {
  caseId: "Case ID (required)",
  memberName: "Member name",
  guardianName: "Guardian / parent",
  memberPhone: "Member phone",
  address: "Address",
  caseManagerName: "Case manager",
  caseManagerEmail: "Case manager email",
  approvedServices: "Approved services",
  status: "AIRnyc status",
  qcReviewer: "QC reviewer",
  isNycha: "NYCHA (yes/no)",
} as const;
export type TrackerField = keyof typeof TRACKER_FIELDS;
export type ColumnMap = Partial<Record<TrackerField, string>>;

export type TrackerRow = { row: number; cells: Record<string, string> };
export type TrackerSheet = { sheet: string; sheets: string[]; headers: string[]; rows: TrackerRow[] };

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text ?? "");
    if ("result" in v) return text(v.result as ExcelJS.CellValue);
    if ("error" in v) return "";
  }
  return String(v).trim();
};

/** Reads one sheet (by name, else the first) with the first non-empty row as headers. */
export async function readTracker(xlsx: Buffer, sheetName?: string | null): Promise<TrackerSheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const sheets = wb.worksheets.map((w) => w.name);
  const ws = (sheetName && wb.getWorksheet(sheetName)) || wb.worksheets[0];
  if (!ws) throw new Error("The workbook has no sheets.");
  let headerRow = 0;
  const headers: string[] = [];
  ws.eachRow((row, n) => {
    if (headerRow) return;
    const vals = (row.values as ExcelJS.CellValue[]).map(text);
    if (vals.filter(Boolean).length >= 2) {
      headerRow = n;
      vals.forEach((v, i) => (headers[i] = v));
    }
  });
  if (!headerRow) throw new Error(`Sheet "${ws.name}" has no header row.`);
  const rows: TrackerRow[] = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const vals = row.values as ExcelJS.CellValue[];
    const cells: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const v = text(vals[i]);
      if (v) any = true;
      cells[h] = v;
    });
    if (any) rows.push({ row: n, cells });
  });
  return { sheet: ws.name, sheets, headers: headers.filter(Boolean), rows };
}

const GUESSES: Record<TrackerField, RegExp> = {
  caseId: /^(case|referral|member)?\s*(id|#|number|no\.?)$|case\s*id|referral\s*id/i,
  memberName: /member\s*name|^member$|client\s*name|patient/i,
  guardianName: /guardian|parent/i,
  memberPhone: /phone|mobile|cell/i,
  address: /^address|street|home\s*address/i,
  caseManagerName: /case\s*manager(?!.*(email|e-mail))|^cm$|cm\s*name|navigator/i,
  caseManagerEmail: /(case\s*manager|cm).*(email|e-mail)|email/i,
  approvedServices: /approved|service/i,
  status: /^status|stage|outcome/i,
  qcReviewer: /qc|quality|reviewer/i,
  isNycha: /nycha/i,
};

/** A starting column mapping from the header names; the owner confirms or changes it in Settings. */
export function guessColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  const taken = new Set<string>();
  for (const field of Object.keys(GUESSES) as TrackerField[]) {
    const h = headers.find((x) => !taken.has(x) && GUESSES[field].test(x));
    if (h) {
      map[field] = h;
      taken.add(h);
    }
  }
  return map;
}

export type TrackerCase = {
  row: number;
  caseId: string;
  memberName: string | null;
  guardianName: string | null;
  memberPhone: string | null;
  address: string | null;
  caseManagerName: string | null;
  caseManagerEmail: string | null;
  approvedServices: string[];
  status: string | null;
  qcReviewer: string | null;
  isNycha: boolean | null;
};

const yes = (v: string) => /^(y|yes|true|1|x)$/i.test(v.trim());

/** Rows → cases. Rows with no case ID are skipped (and counted) rather than failing the sync. */
export function rowsToCases(rows: TrackerRow[], map: ColumnMap): { cases: TrackerCase[]; skipped: number } {
  const col = (r: TrackerRow, f: TrackerField) => (map[f] ? (r.cells[map[f]!] ?? "").trim() : "");
  const opt = (r: TrackerRow, f: TrackerField) => col(r, f) || null;
  const cases: TrackerCase[] = [];
  let skipped = 0;
  for (const r of rows) {
    const caseId = col(r, "caseId").replace(/\s+/g, "");
    if (!caseId) {
      skipped++;
      continue;
    }
    const nycha = col(r, "isNycha");
    cases.push({
      row: r.row,
      caseId,
      memberName: opt(r, "memberName"),
      guardianName: opt(r, "guardianName"),
      memberPhone: opt(r, "memberPhone"),
      address: opt(r, "address"),
      caseManagerName: opt(r, "caseManagerName"),
      caseManagerEmail: opt(r, "caseManagerEmail")?.toLowerCase() ?? null,
      approvedServices: col(r, "approvedServices")
        .split(/[;,\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
      status: opt(r, "status"),
      qcReviewer: opt(r, "qcReviewer"),
      isNycha: nycha ? yes(nycha) : null,
    });
  }
  return { cases, skipped };
}
