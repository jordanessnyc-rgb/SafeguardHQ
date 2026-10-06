/**
 * The only door to the Anthropic API (SPEC §9.8). Every call:
 *  - is BLOCKED when this month's spend has reached settings.ai_monthly_cost_cap_usd,
 *  - is logged to ai_calls with model, tokens, cost, feature, job/activity.
 * Output is schema-validated via structured outputs (client.messages.parse + zodOutputFormat).
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { gte, sql } from "drizzle-orm";
import type { z } from "zod";
import { schema as s, type Db, type Tx } from "@/lib/db";
import { costUsd } from "./config";

type Conn = Db | Tx;
export type AnthropicLike = Pick<Anthropic, "messages">;

export type GuardedResult<T> =
  | { status: "ok"; output: T; model: string; costUsd: number }
  | { status: "blocked"; reason: string }
  | { status: "error"; error: string };

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  client ??= new Anthropic(); // ANTHROPIC_API_KEY from the environment
  return client;
}

export async function guardedParse<Schema extends z.ZodType>(
  conn: Conn,
  opts: {
    feature: string;
    model: string;
    system: string;
    userText: string;
    schema: Schema;
    jobId?: string | null;
    activityId?: string | null;
    maxTokens?: number;
    /** PDFs sent as document blocks (e.g. an RFP). */
    pdfs?: { base64: string; title?: string }[];
  },
  api: AnthropicLike = anthropic(),
): Promise<GuardedResult<z.infer<Schema>>> {
  const log = (v: Partial<typeof s.aiCalls.$inferInsert>) =>
    conn.insert(s.aiCalls).values({
      feature: opts.feature,
      model: opts.model,
      jobId: opts.jobId ?? null,
      activityId: opts.activityId ?? null,
      ...v,
    });

  const [cfg] = await conn.select().from(s.settings);
  if (cfg?.aiMonthlyCostCapUsd) {
    const monthStart = new Date(new Date().toISOString().slice(0, 8) + "01T00:00:00Z");
    const [{ spent }] = await conn
      .select({ spent: sql<string>`coalesce(sum(${s.aiCalls.costUsd}), 0)` })
      .from(s.aiCalls)
      .where(gte(s.aiCalls.at, monthStart));
    if (Number(spent) >= Number(cfg.aiMonthlyCostCapUsd)) {
      await log({ blocked: "monthly_cost_cap" });
      return { status: "blocked", reason: `Monthly AI cost cap ($${cfg.aiMonthlyCostCapUsd}) reached.` };
    }
  }

  try {
    const res = await api.messages.parse({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [
        {
          role: "user",
          content: [
            ...(opts.pdfs ?? []).map((d) => ({ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: d.base64 }, ...(d.title ? { title: d.title } : {}) })),
            { type: "text" as const, text: opts.userText },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(opts.schema) },
    });
    const cost = costUsd(opts.model, res.usage.input_tokens, res.usage.output_tokens);
    const base = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, costUsd: cost.toFixed(5) };
    if (res.stop_reason === "refusal" || res.parsed_output == null) {
      const reason = res.stop_reason === "refusal" ? "refusal" : `unparseable output (stop_reason=${res.stop_reason})`;
      await log({ ...base, error: reason });
      return { status: "error", error: reason };
    }
    await log(base);
    return { status: "ok", output: res.parsed_output, model: opts.model, costUsd: cost };
  } catch (e) {
    const msg =
      e instanceof Anthropic.APIConnectionError
        ? `Couldn't reach the AI service (${e.message}). Try again shortly.`
        : e instanceof Anthropic.APIError
          ? `API ${e.status}: ${e.message}`
          : (e as Error).message;
    await log({ error: msg.slice(0, 500) });
    return { status: "error", error: msg };
  }
}
