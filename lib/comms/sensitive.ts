/**
 * AIRnyc-linked message content (member names, health/housing conditions) is stored encrypted in
 * activities.sensitive_enc, never in subject/body/transcript (CLAUDE.md rule 5). Reads go through
 * revealActivity(), which writes an audit_log row.
 */
import { schema as s, type Db, type Tx } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto";

export type SensitiveContent = { subject?: string | null; body?: string | null; transcript?: string | null; summary?: string | null };

export function sealContent(c: SensitiveContent) {
  return {
    sensitive: true,
    sensitiveEnc: encryptField(JSON.stringify(c)),
    ...(c.subject !== undefined ? { subject: c.subject ? "[AIRnyc — protected]" : null } : {}),
    body: null,
    transcript: null,
    summary: null,
  };
}

/** Adds fields to an already-sealed payload (e.g. a transcript arriving after the summary). */
export function mergeSealed(existingEnc: string | null, add: SensitiveContent) {
  return sealContent({ ...openContent(existingEnc), ...add });
}

export function openContent(enc: string | null): SensitiveContent {
  const plain = decryptField(enc);
  return plain ? (JSON.parse(plain) as SensitiveContent) : {};
}

export async function revealActivity(conn: Db | Tx, actor: string | null, activity: { id: string; sensitiveEnc: string | null }, view: string) {
  await conn.insert(s.auditLog).values({ actor, action: "READ", entity: "activities", entityId: activity.id, detail: { view, sensitive: true } });
  return openContent(activity.sensitiveEnc);
}

/** AIRnyc case IDs look like PHS_0148, Emblem_0022, SIPPS_7. */
export const AIRNYC_CASE_ID_RE = /\b(PHS|Emblem|EMBLEM|SIPPS)[_-]\d{2,6}\b/g;
