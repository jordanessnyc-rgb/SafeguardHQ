/**
 * Parsing for the Settings page. The page saves one section at a time, so each save may only touch the
 * columns that section owns — a section's form never contains the others' fields, and treating a missing
 * checkbox as "off" would silently switch other settings off.
 */
import { z } from "zod";
import { checkbox, formObject } from "@/lib/actions";
import type { schema as s } from "@/lib/db";

type Settings = typeof s.settings.$inferSelect;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const folderId = z
  .string()
  .optional()
  // Accept a pasted folder URL as well as a bare ID.
  .transform((v) => (v ? (v.match(/folders\/([\w-]+)/)?.[1] ?? v) : null));

const settingsSchema = z.object({
  autoSendEmail: checkbox,
  autoSendSms: checkbox,
  autoCreateInvoice: checkbox,
  holdReportUntilPaidDefault: checkbox,
  airnycAiAllowed: checkbox,
  airnycMode: z.enum(["MANUAL", "EMAIL"]), // POWER_AUTOMATE / GRAPH need AIRnyc's written approval first
  digestRecipients: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(/[,\s]+/).filter(Boolean))
    .pipe(z.array(z.email())),
  digestTime: hhmm,
  digestEnabled: checkbox,
  digestSmsEnabled: checkbox,
  invoicePaymentTermsDays: z.coerce.number().int().min(0).max(120),
  driveJobsParentFolderId: folderId,
  driveAirnycParentFolderId: folderId,
  driveTemplateFolderId: folderId,
  aiMonthlyCostCapUsd: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/[$,]/g, "") : null))
    .refine((v) => v === null || /^\d+(\.\d{1,2})?$/.test(v), "Enter a dollar amount"),
});
type Field = keyof typeof settingsSchema.shape;

/** Which settings columns each Settings section edits. `hours` edits business_hours (not in the schema). */
export const SETTINGS_SECTIONS = {
  approvals: ["autoSendEmail", "autoSendSms", "autoCreateInvoice", "holdReportUntilPaidDefault", "invoicePaymentTermsDays"],
  digest: ["digestEnabled", "digestSmsEnabled", "digestRecipients", "digestTime"],
  airnyc: ["airnycAiAllowed", "airnycMode"],
  drive: ["driveJobsParentFolderId", "driveAirnycParentFolderId", "driveTemplateFolderId"],
  budget: ["aiMonthlyCostCapUsd"],
  hours: [],
} as const satisfies Record<string, readonly Field[]>;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

const CHECKBOXES: Field[] = ["autoSendEmail", "autoSendSms", "autoCreateInvoice", "holdReportUntilPaidDefault", "airnycAiAllowed", "digestEnabled", "digestSmsEnabled"];

export const isSettingsSection = (v: unknown): v is SettingsSection => typeof v === "string" && Object.hasOwn(SETTINGS_SECTIONS, v);

/** The partial settings update for one section's form. Throws (zod) on invalid input. */
export function parseSettingsSection(section: SettingsSection, form: FormData): Partial<Settings> {
  const raw = formObject(form);
  if (section === "hours") {
    const businessHours = Object.fromEntries(
      DAYS.map((d) => {
        const open = raw[`${d}Open`];
        const close = raw[`${d}Close`];
        return [d, open && close ? { open: hhmm.parse(open), close: hhmm.parse(close) } : null];
      }),
    ) as Settings["businessHours"];
    return { businessHours };
  }
  const fields = SETTINGS_SECTIONS[section] as readonly Field[];
  const pick = Object.fromEntries(fields.map((f) => [f, true])) as { [K in Field]?: true };
  const input: Record<string, unknown> = { ...raw };
  // Unchecked checkboxes aren't submitted at all; read them explicitly so "off" is saved as off.
  for (const f of CHECKBOXES) if (fields.includes(f)) input[f] = form.get(f);
  return settingsSchema.pick(pick).parse(input) as Partial<Settings>;
}
