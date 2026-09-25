/**
 * Weekly export of the CRM's tables to Google Drive (SPEC §13 "weekly export of core tables to
 * Drive"), on top of Supabase's daily backups: one zip of CSVs, readable in Excel without us.
 *
 * - Every public table is included except the ones below, so new tables are covered automatically.
 * - AIRnyc member fields stay as stored, i.e. encrypted (`*_enc`); the key is not in the export.
 * - Credentials (FreshBooks tokens, MCP token hashes) and high-volume plumbing are left out.
 */
import PizZip from "pizzip";
import type { Pool } from "pg";
import type { DriveClient } from "@/lib/integrations/google-drive";

export const EXCLUDED_TABLES = new Set([
  "freshbooks_connection", // OAuth tokens
  "mcp_tokens", // token hashes
  "webhook_deliveries", // raw provider payloads; replayable from the providers
  "worker_status",
  "mail_sync_state",
]);
export const PREFIX = "ess-crm-export-";
export const KEEP = 12; // weeks

/** RFC 4180 field: quote when needed; objects as JSON, dates as ISO. */
export function csvField(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Text that a spreadsheet would run as a formula gets a leading apostrophe; negative numbers don't.
  const formula = /^[=+@\t\r]/.test(s) || /^-(?![\d.]+$)/.test(s);
  const out = formula ? `'${s}` : s;
  return formula || /[",\r\n]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return [columns.map(csvField).join(","), ...rows.map((r) => columns.map((c) => csvField(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** Builds the zip from the privileged connection (the worker's). */
export async function buildExport(pool: Pool, now = new Date()): Promise<{ zip: Buffer; tables: Record<string, number> }> {
  const { rows: tables } = await pool.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by 1`,
  );
  const zip = new PizZip();
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    if (EXCLUDED_TABLES.has(name)) continue;
    // Identifier comes from pg_class, quoted anyway. Types stay as pg returns them (numeric as text).
    const res = await pool.query(`select * from public."${name.replace(/"/g, '""')}"`);
    zip.file(`${name}.csv`, "﻿" + toCsv(res.fields.map((f) => f.name), res.rows)); // BOM so Excel reads UTF-8
    counts[name] = res.rowCount ?? res.rows.length;
  }
  zip.file(
    "README.txt",
    [
      `ESS CRM export, ${now.toISOString()}`,
      "",
      "One CSV per database table. Open in Excel or Google Sheets.",
      "Columns ending in _enc (AIRnyc member details) are encrypted; decrypting them needs AIRNYC_ENCRYPTION_KEY,",
      "which is deliberately not part of this export.",
      `Not included: ${[...EXCLUDED_TABLES].join(", ")} (credentials and system bookkeeping).`,
      "Full restores use the Supabase daily backups; see docs/RUNBOOK.md.",
      "",
      ...Object.entries(counts).map(([t, n]) => `${t}: ${n} rows`),
    ].join("\r\n"),
  );
  return { zip: zip.generate({ type: "nodebuffer", compression: "DEFLATE" }), tables: counts };
}

/** Uploads this week's export once (idempotent by file name) and trashes exports beyond the newest KEEP. */
export async function runWeeklyExport(pool: Pool, drive: DriveClient, folderId: string, now = new Date()) {
  const name = `${PREFIX}${now.toISOString().slice(0, 10)}.zip`;
  const existing = await drive.listByPrefix(folderId, PREFIX);
  let uploaded: string | null = null;
  let tables: Record<string, number> = {};
  if (!existing.some((f) => f.name === name)) {
    const built = await buildExport(pool, now);
    tables = built.tables;
    uploaded = await drive.uploadToFolder(folderId, name, built.zip, "application/zip");
  }
  const all = uploaded ? [{ id: uploaded, name }, ...existing] : existing;
  const old = all.slice(KEEP);
  for (const f of old) await drive.trash(f.id);
  return { name, uploaded: Boolean(uploaded), trashed: old.length, tables };
}
