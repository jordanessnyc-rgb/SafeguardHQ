/** AIRnyc case data access (SPEC §7). AIRnyc data is handled like any other client data (CLAUDE.md rule 5). */
import { desc, eq, isNull } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";

export type MemberFields = {
  memberName: string | null;
  guardianName: string | null;
  memberPhone: string | null;
  address: string | null;
};

export type AirnycCase = typeof s.airnycCases.$inferSelect;

/** AIRnyc case IDs look like PHS_0148, Emblem_0022, SIPPS_7. */
export const AIRNYC_CASE_ID_RE = /\b(PHS|Emblem|EMBLEM|SIPPS)[_-]\d{2,6}\b/g;

const NETWORKS: Record<string, string> = { PHS: "PHS", EMBLEM: "EMBLEM", SIPPS: "SIPPS" };

/** "PHS_0148" → "PHS", "Emblem_22" → "EMBLEM". Unknown prefixes are kept upper-cased. */
export function networkFromCaseId(caseId: string): string | null {
  const prefix = caseId.trim().split(/[_\-\s]/)[0]?.toUpperCase();
  return prefix ? (NETWORKS[prefix] ?? prefix) : null;
}

export async function listCases(tx: Tx): Promise<AirnycCase[]> {
  return tx.select().from(s.airnycCases).where(isNull(s.airnycCases.archivedAt)).orderBy(desc(s.airnycCases.createdAt)).limit(500);
}

export async function getCase(tx: Tx | Db, id: string): Promise<AirnycCase | null> {
  const [row] = await tx.select().from(s.airnycCases).where(eq(s.airnycCases.id, id));
  return row ?? null;
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
