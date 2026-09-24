/**
 * Quote builder (SPEC §10): Jordan's pricing rule for the service + the job's size and sample
 * count → invoice-ready line items. No prices live in code: with no rule, only lines entered by
 * hand are used.
 */
import type { QuoteInputs } from "@/db/schema";

export type PricingRule = {
  baseAmount: string;
  includedSqft: number;
  perSqft: string | null;
  includedSamples: number;
  perSample: string | null;
  minimumAmount: string | null;
};
export type QuoteLine = { description: string; quantity: number; unitPrice: number };

const cents = (n: number) => Math.round(n * 100) / 100;

export function computeQuote(serviceName: string, rule: PricingRule | null, inputs: QuoteInputs): { lines: QuoteLine[]; total: number; notes: string[] } {
  const lines: QuoteLine[] = [];
  const notes: string[] = [];
  if (rule) {
    lines.push({ description: serviceName, quantity: 1, unitPrice: cents(Number(rule.baseAmount)) });
    const sqft = Math.max(0, Math.round(inputs.sqft ?? 0));
    if (rule.perSqft && sqft > rule.includedSqft) {
      const extra = sqft - rule.includedSqft;
      lines.push({ description: `Additional area (${extra.toLocaleString("en-US")} sq ft over ${rule.includedSqft.toLocaleString("en-US")})`, quantity: extra, unitPrice: Number(rule.perSqft) });
    }
    const samples = Math.max(0, Math.round(inputs.samples ?? 0));
    if (rule.perSample && samples > rule.includedSamples) {
      const extra = samples - rule.includedSamples;
      lines.push({ description: rule.includedSamples ? `Additional samples (over ${rule.includedSamples} included)` : "Laboratory samples", quantity: extra, unitPrice: cents(Number(rule.perSample)) });
    }
  } else {
    notes.push(`No pricing rule for ${serviceName} — only the lines entered by hand are priced (Settings → Pricing).`);
  }
  for (const e of inputs.extras ?? []) lines.push({ description: e.description, quantity: e.quantity, unitPrice: cents(e.unitPrice) });

  let total = cents(lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0));
  const min = rule?.minimumAmount ? Number(rule.minimumAmount) : 0;
  if (min && total < min) {
    lines.push({ description: "Minimum service charge adjustment", quantity: 1, unitPrice: cents(min - total) });
    notes.push(`Raised to the ${serviceName} minimum.`);
    total = cents(min);
  }
  return { lines, total, notes };
}
