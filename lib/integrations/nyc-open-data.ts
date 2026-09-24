/**
 * NYC address resolution (Planning Labs GeoSearch v2) and NYC Open Data (Socrata) enrichment.
 * SPEC §4.1, §6.5. Dataset IDs and field names verified against the live dataset metadata
 * (api/views/{id}.json) on 2026-09-24 — see docs/DECISIONS.md.
 *
 * Everything here is pure or takes an injectable `fetch`, so it is unit-testable offline.
 */

export const GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search";
export const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";

export const DATASETS = {
  hpdViolations: "wvxf-dwi5",
  hpdRegistrations: "tesw-yqqr",
  hpdRegistrationContacts: "feu5-w2e2",
  pluto: "64uk-42ks",
  dobViolations: "3h2n-5cm9",
  ecbViolations: "6bgk-3dad",
} as const;

/** Upper bound of rows pulled per dataset per property (big portfolios can have thousands). */
export const MAX_ROWS = 5000;

export type Fetch = typeof fetch;

// ---------------------------------------------------------------------------------------------
// BBL helpers
// ---------------------------------------------------------------------------------------------

export const BOROUGHS: Record<string, string> = {
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
};

/** Accepts "4001750027", "4001750027.00000000", or 4001750027 → "4001750027" (10 digits) or null. */
export function normalizeBbl(v: unknown): string | null {
  if (v == null) return null;
  const digits = String(v).split(".")[0].replace(/\D/g, "");
  return /^[1-5]\d{9}$/.test(digits) ? digits : null;
}

export function splitBbl(bbl: string): { boro: string; block: string; lot: string } {
  return { boro: bbl[0], block: String(Number(bbl.slice(1, 6))), lot: String(Number(bbl.slice(6))) };
}

// ---------------------------------------------------------------------------------------------
// GeoSearch
// ---------------------------------------------------------------------------------------------

export type AddressCandidate = {
  label: string;
  addressLine: string;
  borough: string | null;
  zip: string | null;
  bbl: string | null;
  bin: string | null;
  lat: number | null;
  lng: number | null;
  confidence: number | null;
  raw: unknown;
};

type GeoFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    label?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    borough?: string;
    postalcode?: string;
    confidence?: number;
    addendum?: { pad?: { bbl?: string; bin?: string } };
  };
};

export function parseGeoSearch(body: { features?: GeoFeature[] }): AddressCandidate[] {
  return (body.features ?? []).map((f) => {
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const bin = p.addendum?.pad?.bin ?? null;
    return {
      label: p.label ?? p.name ?? "",
      addressLine: p.name ?? [p.housenumber, p.street].filter(Boolean).join(" "),
      borough: p.borough ?? null,
      zip: p.postalcode ?? null,
      bbl: normalizeBbl(p.addendum?.pad?.bbl),
      // PAD uses x000000 "million BINs" as placeholders for unassigned buildings.
      bin: bin && !/^[1-5]000000$/.test(bin) ? bin : null,
      lat: typeof lat === "number" ? lat : null,
      lng: typeof lng === "number" ? lng : null,
      confidence: p.confidence ?? null,
      raw: f,
    };
  });
}

export async function geosearch(text: string, opts: { size?: number; fetch?: Fetch } = {}): Promise<AddressCandidate[]> {
  const q = text.trim();
  if (q.length < 3) return [];
  const url = `${GEOSEARCH_URL}?${new URLSearchParams({ text: q, size: String(opts.size ?? 5) })}`;
  const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GeoSearch ${res.status}`);
  return parseGeoSearch(await res.json());
}

// ---------------------------------------------------------------------------------------------
// Socrata
// ---------------------------------------------------------------------------------------------

/** Rows per request. SODA's default $limit is 1,000; we page with $offset + a stable $order. */
export const PAGE_SIZE = 1000;

export async function socrata<T = Record<string, string>>(
  dataset: string,
  params: Record<string, string>,
  opts: { fetch?: Fetch; appToken?: string; maxRows?: number } = {},
): Promise<T[]> {
  const maxRows = Math.min(opts.maxRows ?? MAX_ROWS, MAX_ROWS);
  const pageSize = Math.min(PAGE_SIZE, maxRows);
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = opts.appToken ?? process.env.SOCRATA_APP_TOKEN;
  if (token) headers["X-App-Token"] = token;
  // :id is Socrata's row id — a tiebreaker so pages don't overlap or skip rows.
  const order = params.$order ? `${params.$order}, :id` : ":id";

  const rows: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const qs = new URLSearchParams({ ...params, $order: order, $limit: String(pageSize), $offset: String(offset) });
    const res = await (opts.fetch ?? fetch)(`${SOCRATA_BASE}/${dataset}.json?${qs}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Open Data ${dataset} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.slice(0, maxRows);
}

/** Escapes a value for a SoQL string literal. */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------------------------

export type NormalizedViolation = {
  source: "HPD" | "DOB" | "ECB";
  violationId: string;
  class: string | null;
  orderNumber: string | null;
  status: string | null;
  isOpen: boolean;
  issuedDate: string | null; // YYYY-MM-DD
  description: string | null;
  raw: Record<string, unknown>;
};

/** "2014-01-06T00:00:00.000" or "19881031" → "2014-01-06" / "1988-10-31". */
export function toIsoDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const clean = (v: unknown) => (v == null ? null : String(v).replace(/\s+/g, " ").trim() || null);

export function normalizeHpdViolation(r: Record<string, string>): NormalizedViolation {
  return {
    source: "HPD",
    violationId: r.violationid,
    class: clean(r.class),
    orderNumber: clean(r.ordernumber),
    status: clean(r.currentstatus),
    isOpen: (r.violationstatus ?? "").toLowerCase() === "open",
    issuedDate: toIsoDate(r.novissueddate ?? r.inspectiondate),
    description: clean(r.novdescription),
    raw: r,
  };
}

export function normalizeDobViolation(r: Record<string, string>): NormalizedViolation {
  const category = clean(r.violation_category);
  return {
    source: "DOB",
    violationId: r.isn_dob_bis_viol ?? r.number,
    class: clean(r.violation_type_code),
    orderNumber: clean(r.violation_number),
    status: category,
    // e.g. "V-DOB VIOLATION - ACTIVE" vs "V*-DOB VIOLATION - DISMISSED" / "... - Resolved"
    isOpen: /-\s*ACTIVE$/i.test(category ?? ""),
    issuedDate: toIsoDate(r.issue_date),
    description: clean(r.description) ?? clean(r.violation_type),
    raw: r,
  };
}

export function normalizeEcbViolation(r: Record<string, string>): NormalizedViolation {
  const status = clean(r.ecb_violation_status);
  return {
    source: "ECB",
    violationId: r.ecb_violation_number ?? r.isn_dob_bis_extract,
    class: clean(r.severity),
    orderNumber: clean(r.dob_violation_number),
    status,
    isOpen: (status ?? "").toUpperCase() === "ACTIVE",
    issuedDate: toIsoDate(r.issue_date),
    description: clean(r.violation_description) ?? clean(r.section_law_description1),
    raw: r,
  };
}

// ---------------------------------------------------------------------------------------------
// Building facts
// ---------------------------------------------------------------------------------------------

export type BuildingFacts = {
  buildingClass: string | null;
  unitsRes: number | null;
  yearBuilt: number | null;
  ownerName: string | null;
  isNycha: boolean;
};

const NYCHA_OWNER = /(NYC|NEW YORK CITY) HOUSING AUTH/i;

export function parsePluto(rows: Record<string, string>[]): BuildingFacts | null {
  const r = rows[0];
  if (!r) return null;
  const int = (v?: string) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : null);
  const ownerName = clean(r.ownername);
  return {
    buildingClass: clean(r.bldgclass),
    unitsRes: int(r.unitsres),
    yearBuilt: int(r.yearbuilt),
    ownerName,
    isNycha: NYCHA_OWNER.test(ownerName ?? ""),
  };
}

export type HpdRegistration = {
  registrationId: string;
  endDate: string | null;
  contacts: {
    type: string;
    corporationName: string | null;
    name: string | null;
    title: string | null;
    businessAddress: string | null;
  }[];
};

/** Picks the registration with the latest end date (buildings accumulate historical ones). */
export function pickCurrentRegistration(rows: Record<string, string>[]): Record<string, string> | null {
  return (
    [...rows].sort((a, b) => (b.registrationenddate ?? "").localeCompare(a.registrationenddate ?? ""))[0] ?? null
  );
}

export function parseRegistrationContacts(rows: Record<string, string>[]): HpdRegistration["contacts"] {
  return rows.map((r) => ({
    type: r.type,
    corporationName: clean(r.corporationname),
    name: clean([r.firstname, r.middleinitial, r.lastname].filter(Boolean).join(" ")),
    title: clean(r.title),
    businessAddress: clean(
      [r.businesshousenumber, r.businessstreetname, r.businessapartment && `#${r.businessapartment}`, r.businesscity, r.businessstate, r.businesszip]
        .filter(Boolean)
        .join(" "),
    ),
  }));
}

// ---------------------------------------------------------------------------------------------
// One-shot fetch of everything we cache for a property
// ---------------------------------------------------------------------------------------------

export type EnrichmentResult = {
  facts: BuildingFacts | null;
  registration: HpdRegistration | null;
  violations: NormalizedViolation[];
  errors: string[];
};

export async function fetchPropertyData(
  ids: { bbl: string | null; bin: string | null },
  opts: { fetch?: Fetch; appToken?: string } = {},
): Promise<EnrichmentResult> {
  const errors: string[] = [];
  const attempt = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      return fallback;
    }
  };

  const { bbl, bin } = ids;
  const parts = bbl ? splitBbl(bbl) : null;

  const [plutoRows, hpd, dob, ecb, regs] = await Promise.all([
    bbl ? attempt("PLUTO", () => socrata(DATASETS.pluto, { $where: `bbl=${bbl}` }, { ...opts, maxRows: 1 }), []) : [],
    bbl
      ? attempt("HPD violations", () => socrata(DATASETS.hpdViolations, { $where: `bbl=${lit(bbl)}`, $order: "novissueddate DESC" }, opts), [])
      : [],
    bin ? attempt("DOB violations", () => socrata(DATASETS.dobViolations, { $where: `bin=${lit(bin)}`, $order: "issue_date DESC" }, opts), []) : [],
    bin ? attempt("DOB/ECB violations", () => socrata(DATASETS.ecbViolations, { $where: `bin=${lit(bin)}`, $order: "issue_date DESC" }, opts), []) : [],
    parts
      ? attempt(
          "HPD registrations",
          () =>
            socrata(
              DATASETS.hpdRegistrations,
              { $where: `boroid=${lit(parts.boro)} AND block=${lit(parts.block)} AND lot=${lit(parts.lot)}` },
              opts,
            ),
          [],
        )
      : [],
  ]);

  let registration: HpdRegistration | null = null;
  const current = pickCurrentRegistration(regs);
  if (current) {
    const contacts = await attempt(
      "HPD registration contacts",
      () => socrata(DATASETS.hpdRegistrationContacts, { $where: `registrationid=${lit(current.registrationid)}` }, opts),
      [],
    );
    registration = {
      registrationId: current.registrationid,
      endDate: toIsoDate(current.registrationenddate),
      contacts: parseRegistrationContacts(contacts),
    };
  }

  const violations = [
    ...hpd.map(normalizeHpdViolation),
    ...dob.map(normalizeDobViolation),
    ...ecb.map(normalizeEcbViolation),
  ].filter((v) => v.violationId);

  if (!bbl && !bin) errors.push("Property has no BBL/BIN yet — resolve the address first.");

  return { facts: parsePluto(plutoRows), registration, violations, errors };
}
