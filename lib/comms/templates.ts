/** {{token}} rendering for SMS/email templates. Unknown tokens render empty and are reported. */
export type TemplateVars = Partial<
  Record<
    "first_name" | "last_name" | "job_number" | "address" | "scheduled_date" | "scheduled_time" | "brand_name" | "brand_phone" | "review_url",
    string | null | undefined
  >
>;

/**
 * `missing: "placeholder"` (manual compose) leaves a visible [scheduled date] for a person to fill;
 * `"blank"` (automatic messages like missed-call text-back) drops it.
 */
export function renderTemplate(
  body: string,
  vars: TemplateVars,
  opts: { missing?: "blank" | "placeholder" } = {},
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
      const v = vars[key as keyof TemplateVars];
      if (v == null || v === "") {
        missing.push(key);
        return opts.missing === "placeholder" ? `[${key.replace(/_/g, " ")}]` : "";
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

/** True if a message still contains an unfilled [placeholder] from renderTemplate. */
export function hasUnfilledPlaceholder(text: string): string | null {
  return text.match(/\[(first name|last name|job number|address|scheduled date|scheduled time|brand name|brand phone|review url)\]/)?.[0] ?? null;
}
