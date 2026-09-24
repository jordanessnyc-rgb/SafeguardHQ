/**
 * SPEC §9.4 redaction: before any AIRnyc-linked text leaves the system, replace member names,
 * DOBs, phone numbers, emails, case IDs, and street addresses with stable tokens; re-insert them
 * in the model's output. Known names (from the case record) are replaced first; the regexes are a
 * safety net, not a guarantee — which is why AIRnyc AI stays OFF until AIRnyc approves it.
 */
export type RedactionMap = Map<string, string>;

const PATTERNS: [kind: string, re: RegExp][] = [
  ["CASE_ID", /\b(?:PHS|Emblem|EMBLEM|SIPPS)[_-]\d{2,6}\b/g],
  ["EMAIL", /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
  ["DOB", /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)?\d{2}\b|\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? (?:19|20)\d{2}\b/gi],
  ["PHONE", /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g],
  [
    "ADDRESS",
    /\b\d{1,5}(?:-\d{1,4})?\s+(?:[NSEW]\.?\s+)?(?:[A-Z0-9][\w'.-]*\s+){0,4}(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Pl(?:ace)?|Dr(?:ive)?|Ln|Lane|Ct|Court|Pkwy|Parkway|Ter(?:race)?|Way|Sq(?:uare)?|Tpke|Turnpike)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Fl(?:oor)?|#)\.?\s*[\w-]+)?/gi,
  ],
];

export function redact(text: string, knownNames: (string | null | undefined)[] = []): { text: string; map: RedactionMap } {
  const map: RedactionMap = new Map();
  const counters: Record<string, number> = {};
  const tokenFor = (kind: string, value: string) => {
    for (const [tok, v] of map) if (v === value) return tok;
    const tok = `[${kind}_${(counters[kind] = (counters[kind] ?? 0) + 1)}]`;
    map.set(tok, value);
    return tok;
  };

  let out = text;
  // Full names first, then their parts (so "Ana Lopez" → one token, a lone "Lopez" → another).
  const names = knownNames.flatMap((n) => (n ? [n.trim(), ...n.trim().split(/\s+/)] : [])).filter((n) => n.length >= 3);
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, (m) => tokenFor("NAME", m));
  }
  for (const [kind, re] of PATTERNS) out = out.replace(re, (m) => tokenFor(kind, m));
  return { text: out, map };
}

export function unredact<T>(value: T, map: RedactionMap): T {
  if (map.size === 0) return value;
  const fix = (s: string) => s.replace(/\[[A-Z_]+_\d+\]/g, (tok) => map.get(tok) ?? tok);
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? fix(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}
