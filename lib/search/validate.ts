/**
 * Guard for AI-generated SQL (SPEC §9.6). Defense in depth: this validator, then execution as the
 * asking user (RLS) inside a READ ONLY transaction with a statement timeout and a row cap.
 */
import { CATALOG, type CatalogTable } from "./catalog";

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|execute|prepare|deallocate|listen|notify|unlisten|lock|vacuum|analyze|refresh|reindex|cluster|comment|security|set|reset|begin|commit|rollback|savepoint|into|returning)\b/i;
const FORBIDDEN_REFS = /\b(pg_\w+|information_schema|auth\.|storage\.|pgboss|set_config|current_setting|dblink\w*|lo_\w+|txid_\w*|query_to_xml|xpath|version\s*\()/i;
const SECRET_COLS = /\b(\w+_enc|raw|payload|webhook_callbacks|transcript|body|subject|summary|sensitive|notes|description_enc)\b/i;
const TABLE_FUNCS = new Set(["unnest", "generate_series"]);

export type Validated = { ok: true; sql: string } | { ok: false; reason: string };

export function validateSql(input: string, allowed: CatalogTable[] = CATALOG, maxRows = 200): Validated {
  let q = input.trim();
  if (q.includes("--") || q.includes("/*")) return { ok: false, reason: "Comments aren't allowed." };
  q = q.replace(/;\s*$/, "");
  if (q.includes(";")) return { ok: false, reason: "Only one statement is allowed." };
  if (!/^(select|with)\b/i.test(q)) return { ok: false, reason: "Only SELECT queries are allowed." };
  // Ignore quoted text when checking keywords/tables (a value like 'Delete me' is fine).
  const bare = q.replace(/'(?:[^']|'')*'/g, "''");
  const kw = bare.match(FORBIDDEN);
  if (kw) return { ok: false, reason: `"${kw[0]}" isn't allowed in a search.` };
  const ref = bare.match(FORBIDDEN_REFS);
  if (ref) return { ok: false, reason: `"${ref[0]}" isn't allowed in a search.` };
  // No "*" projections (they'd reach columns the catalog never lists); count(*) is fine.
  if (/\*/.test(bare.replace(/count\s*\(\s*\*\s*\)/gi, "count(1)"))) return { ok: false, reason: "Name the columns to show (no *)." };
  const col = bare.match(SECRET_COLS);
  if (col) return { ok: false, reason: `The "${col[0]}" field isn't available to search.` };

  const names = new Set(allowed.map((t) => t.name));
  const ctes = new Set([...bare.matchAll(/(?:\bwith|,)\s+(?:recursive\s+)?"?(\w+)"?\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  for (const m of bare.matchAll(/\b(from|join)\s+(\(|lateral\b|"?[\w.]+"?)(\s*\()?/gi)) {
    const target = m[2];
    if (target === "(" || /^lateral$/i.test(target)) continue; // subquery
    const name = target.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
    if (m[3]) {
      if (!TABLE_FUNCS.has(name)) return { ok: false, reason: `Function "${name}" isn't allowed here.` };
      continue;
    }
    if (!names.has(name) && !ctes.has(name)) return { ok: false, reason: `Table "${name}" isn't available to search.` };
  }
  return { ok: true, sql: `select * from (${q}) as nl_result limit ${maxRows}` };
}
