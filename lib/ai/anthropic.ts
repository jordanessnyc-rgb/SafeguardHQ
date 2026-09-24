/**
 * The only door to the Anthropic API (SPEC §9.4, §9.8, CLAUDE.md rule 5). Every call:
 *  - is BLOCKED (and logged) when the payload is AIRnyc-linked and settings.airnyc_ai_allowed=false,
 *  - is redacted/unredacted when AIRnyc-linked and allowed,
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
import { redact, unredact } from "./redact";

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
    airnycLinked: boolean;
    knownNames?: (string | null | undefined)[];
    jobId?: string | null;
    activityId?: string | null;
    maxTokens?: number;
  },
  api: AnthropicLike = anthropic(),
): Promise<GuardedResult<z.infer<Schema>>> {
  const log = (v: Partial<typeof s.aiCalls.$inferInsert>) =>
    conn.insert(s.aiCalls).values({
      feature: opts.feature,
      model: opts.model,
      jobId: opts.jobId ?? null,
      activityId: opts.activityId ?? null,
      airnycLinked: opts.airnycLinked,
      ...v,
    });

  const [cfg] = await conn.select().from(s.settings);
  if (opts.airnycLinked && !cfg?.airnycAiAllowed) {
    await log({ blocked: "airnyc_ai_allowed=false" });
    return { status: "blocked", reason: "AIRnyc-linked content; AI is disabled for AIRnyc data (Settings)." };
  }
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

  const { text: userText, map } = opts.airnycLinked ? redact(opts.userText, opts.knownNames) : { text: opts.userText, map: new Map() };

  try {
    const res = await api.messages.parse({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: "user", content: userText }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });
    const cost = costUsd(opts.model, res.usage.input_tokens, res.usage.output_tokens);
    const base = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, costUsd: cost.toFixed(5), redacted: map.size > 0 };
    if (res.stop_reason === "refusal" || res.parsed_output == null) {
      const reason = res.stop_reason === "refusal" ? "refusal" : `unparseable output (stop_reason=${res.stop_reason})`;
      await log({ ...base, error: reason });
      return { status: "error", error: reason };
    }
    await log(base);
    return { status: "ok", output: unredact(res.parsed_output, map), model: opts.model, costUsd: cost };
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : (e as Error).message;
    await log({ error: msg.slice(0, 500) });
    return { status: "error", error: msg };
  }
}
