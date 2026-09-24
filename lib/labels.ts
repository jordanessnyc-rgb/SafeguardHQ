/** Human labels for enum values shown in the UI. */
export const SERVICE_LABELS: Record<string, string> = {
  MOLD_ASSESS: "Mold assessment",
  MOLD_PLAN: "Mold remediation work plan",
  MOLD_CLEAR: "Post-remediation clearance",
  LEAD_RA: "Lead risk assessment / inspection",
  LEAD_CLEAR: "Lead dust wipe clearance",
  LEAD_WATER: "Lead in drinking water",
  ASB_SURVEY: "Asbestos survey",
  LL152: "LL152 gas piping",
  LL126: "LL126 parapet",
  LL31: "LL31 lead paint",
  VIOLATION: "HPD/DOB violation support",
  AIRNYC: "AIRnyc SCN referral",
  BID: "Government bid",
};

export const BRAND_LABELS: Record<string, string> = { ESS: "ESS", GAS_PRO: "Gas Pro Inspectors" };

export const ORG_TYPE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  MANAGEMENT_CO: "Management company",
  REFERRAL_PARTNER: "Referral partner",
  GOV_AGENCY: "Government agency",
  SUBCONTRACTOR: "Subcontractor",
  LAB: "Lab",
  OTHER: "Other",
};

export const SOURCE_LABELS: Record<string, string> = {
  WEB_FORM: "Web form",
  QUO: "Quo (phone/SMS)",
  EMAIL: "Email",
  MAILER_CAMPAIGN: "Mailer campaign",
  REFERRAL: "Referral",
  BID: "Bid",
  MANUAL: "Manual entry",
};

export const titleCase = (v: string) =>
  v
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

export const label = (map: Record<string, string>, v: string | null | undefined) => (v ? (map[v] ?? titleCase(v)) : "—");

export function fmtDate(d: Date | string | null | undefined, withTime = false): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T12:00:00` : d) : d;
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

export const personName = (c: { firstName?: string | null; lastName?: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed contact";

/** $1,234.50 — accepts numeric strings from Postgres. */
export const usd = (v: number | string | null | undefined, cents = true) =>
  Number(v ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
