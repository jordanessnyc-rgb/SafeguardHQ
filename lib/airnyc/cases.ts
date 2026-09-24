/**
 * AIRnyc case data access (SPEC §7). Member fields are encrypted at rest with lib/crypto and every
 * decrypting read is written to audit_log. Pages must use these functions — never select the
 * *_enc columns directly.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { decryptField, encryptField } from "@/lib/crypto";

export type MemberFields = {
  memberName: string | null;
  guardianName: string | null;
  memberPhone: string | null;
  address: string | null;
};

type CaseRow = typeof s.airnycCases.$inferSelect;
export type AirnycCase = Omit<CaseRow, "memberNameEnc" | "guardianNameEnc" | "memberPhoneEnc" | "addressEnc"> & MemberFields;

const NETWORKS: Record<string, string> = { PHS: "PHS", EMBLEM: "EMBLEM", SIPPS: "SIPPS" };

/** "PHS_0148" → "PHS", "Emblem_22" → "EMBLEM". Unknown prefixes are kept upper-cased. */
export function networkFromCaseId(caseId: string): string | null {
  const prefix = caseId.trim().split(/[_\-\s]/)[0]?.toUpperCase();
  return prefix ? (NETWORKS[prefix] ?? prefix) : null;
}

export function encryptMember(m: Partial<MemberFields>) {
  return {
    ...(m.memberName !== undefined && { memberNameEnc: encryptField(m.memberName) }),
    ...(m.guardianName !== undefined && { guardianNameEnc: encryptField(m.guardianName) }),
    ...(m.memberPhone !== undefined && { memberPhoneEnc: encryptField(m.memberPhone) }),
    ...(m.address !== undefined && { addressEnc: encryptField(m.address) }),
  };
}

function decryptRow(row: CaseRow): AirnycCase {
  const { memberNameEnc, guardianNameEnc, memberPhoneEnc, addressEnc, ...rest } = row;
  return {
    ...rest,
    memberName: decryptField(memberNameEnc),
    guardianName: decryptField(guardianNameEnc),
    memberPhone: decryptField(memberPhoneEnc),
    address: decryptField(addressEnc),
  };
}

async function logRead(tx: Tx | Db, actor: string | null, rows: CaseRow[], view: string) {
  if (rows.length === 0) return;
  await tx.insert(s.auditLog).values(
    rows.map((r) => ({
      actor,
      action: "READ",
      entity: "airnyc_cases",
      entityId: r.id,
      detail: { view, caseId: r.caseId, fields: ["member_name", "guardian_name", "member_phone", "address"] },
    })),
  );
}

export async function listCases(tx: Tx, actor: string | null): Promise<AirnycCase[]> {
  const rows = await tx.select().from(s.airnycCases).where(isNull(s.airnycCases.archivedAt)).orderBy(desc(s.airnycCases.createdAt)).limit(500);
  await logRead(tx, actor, rows, "list");
  return rows.map(decryptRow);
}

export async function getCase(tx: Tx | Db, actor: string | null, id: string): Promise<AirnycCase | null> {
  const [row] = await tx.select().from(s.airnycCases).where(and(eq(s.airnycCases.id, id)));
  if (!row) return null;
  await logRead(tx, actor, [row], "detail");
  return decryptRow(row);
}

export const lastNameOf = (fullName: string | null) => fullName?.trim().split(/\s+/).at(-1) ?? null;

/** Expands a checklist file-name pattern: {CASE_ID}, {LAST_NAME}, {DATE}. */
export function expandFileName(pattern: string, c: { caseId: string; memberName: string | null }, today = new Date()) {
  const date = today.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return pattern
    .replaceAll("{CASE_ID}", c.caseId)
    .replaceAll("{LAST_NAME}", lastNameOf(c.memberName) ?? "Member")
    .replaceAll("{DATE}", date);
}
