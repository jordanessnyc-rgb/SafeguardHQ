/** {{token}} rendering for SMS/email templates. Unknown tokens render empty and are reported. */
export type TemplateVars = Partial<
  Record<
    "first_name" | "last_name" | "job_number" | "address" | "scheduled_date" | "scheduled_time" | "brand_name" | "brand_phone" | "review_url",
    string | null | undefined
  >
>;

export function renderTemplate(body: string, vars: TemplateVars): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
      const v = vars[key as keyof TemplateVars];
      if (v == null || v === "") {
        missing.push(key);
        return "";
      }
      return v;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
  return { text, missing };
}

export const BRAND_INFO = {
  ESS: { name: "Environmental Safeguard Solutions", phone: "929-305-1232" },
  GAS_PRO: { name: "Gas Pro Inspectors", phone: "929-305-1232" },
} as const;
