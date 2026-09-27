/**
 * Weekly export of the CRM's tables (SPEC §13), on top of Supabase's daily backups: one zip of
 * CSVs, readable in Excel without us. Stored in Google Drive when it's configured, otherwise in a
 * private Supabase Storage bucket (`backups`, service role only) that the owner downloads from
 * System health. ESS keeps its files on Synology, so the Storage copy is the default.
 *
 * - Every public table is included except the ones below, so new tables are covered automatically.
 * - AIRnyc member fields stay as stored, i.e. encrypted (`*_enc`); the key is not in the export.
 * - Credentials (FreshBooks tokens, MCP token hashes) and high-volume plumbing are left out.
 */
import PizZip from "pizzip";
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
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

/** Where exports go. `list` returns this CRM's exports, newest first. */
export type BackupTarget = {
  kind: "drive" | "storage";
  list(): Promise<{ id: string; name: string }[]>;
  upload(name: string, data: Buffer): Promise<string>;
  remove(ids: string[]): Promise<void>;
};

export function driveTarget(drive: DriveClient, folderId: string): BackupTarget {
  return {
    kind: "drive",
    list: () => drive.listByPrefix(folderId, PREFIX),
    upload: (name, data) => drive.uploadToFolder(folderId, name, data, "application/zip"),
    remove: async (ids) => {
      for (const id of ids) await drive.trash(id);
    },
  };
}

export const BACKUP_BUCKET = "backups";

export function storageTarget(sb: SupabaseClient): BackupTarget {
  const bucket = () => sb.storage.from(BACKUP_BUCKET);
  return {
    kind: "storage",
    async list() {
      const { data, error } = await bucket().list("", { search: PREFIX, limit: 1000, sortBy: { column: "name", order: "desc" } });
      if (error) throw new Error(`Backup list failed: ${error.message}`);
      // Names carry the date, so name order is age order.
      return (data ?? []).filter((f) => f.name.startsWith(PREFIX)).map((f) => ({ id: f.name, name: f.name })).sort((a, b) => b.name.localeCompare(a.name));
    },
    async upload(name, data) {
      const { error } = await bucket().upload(name, data, { contentType: "application/zip", upsert: true });
      if (error) throw new Error(`Backup upload failed: ${error.message}`);
      return name;
    },
    async remove(ids) {
      if (!ids.length) return;
      const { error } = await bucket().remove(ids);
      if (error) throw new Error(`Backup cleanup failed: ${error.message}`);
    },
  };
}

/** Uploads today's export once (idempotent by file name) and removes exports beyond the newest KEEP. */
export async function runWeeklyExport(pool: Pool, target: BackupTarget, now = new Date()) {
  const name = `${PREFIX}${now.toISOString().slice(0, 10)}.zip`;
  const existing = await target.list();
  let uploaded: string | null = null;
  let tables: Record<string, number> = {};
  if (!existing.some((f) => f.name === name)) {
    const built = await buildExport(pool, now);
    tables = built.tables;
    uploaded = await target.upload(name, built.zip);
  }
  const all = uploaded ? [{ id: uploaded, name }, ...existing] : existing;
  const old = all.slice(KEEP);
  await target.remove(old.map((f) => f.id));
  return { name, uploaded: Boolean(uploaded), trashed: old.length, tables };
}
