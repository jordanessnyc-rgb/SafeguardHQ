/**
 * AI model config (SPEC §9: "keep model names in config, not code"). Override per env var.
 * Prices are USD per million tokens (Anthropic pricing, checked 2026-09-24) — used for the
 * ai_calls cost log and the monthly cost cap. Unknown models are logged at the Opus rate.
 */
export const AI_MODELS = {
  classify: process.env.AI_MODEL_CLASSIFY ?? "claude-haiku-4-5",
  draft: process.env.AI_MODEL_DRAFT ?? "claude-sonnet-5",
  report: process.env.AI_MODEL_REPORT ?? "claude-opus-5",
} as const;

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
