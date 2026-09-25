/**
 * Natural-language search (SPEC §9.6): question → AI-written SELECT (validated) → run as the asking
 * user under RLS in a READ ONLY transaction with a 5 s timeout. The model sees the question and the
 * table catalog only — never any row data; results go straight to the screen.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { runAsUser, type Db, type JwtClaims } from "@/lib/db";
import { AI_MODELS } from "@/lib/ai/config";
import { guardedParse, type AnthropicLike } from "@/lib/ai/anthropic";
import { NL_SEARCH_SYSTEM } from "@/lib/ai/prompts/nl-search";
import { nyDate } from "@/lib/time";
import { catalogFor, describeCatalog } from "./catalog";
import { validateSql } from "./validate";

const NlSchema = z.object({ sql: z.string().nullable(), explanation: z.string(), cannot_answer: z.string().nullable() });

export type SearchResult =
  | { status: "ok"; sql: string; explanation: string; columns: string[]; rows: Record<string, unknown>[] }
  | { status: "refused" | "error"; reason: string; sql?: string };

/** Runs an already-validated query as the user (RLS), read-only, time-limited. */
export async function runReadOnly(db: Db, claims: JwtClaims, query: string) {
  return runAsUser(db, claims, async (tx) => {
    await tx.execute(sql`set local transaction_read_only = on`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    const res = await tx.execute(sql.raw(query));
    return { rows: res.rows as Record<string, unknown>[], columns: res.fields.map((f) => f.name) };
  });
}

export async function naturalLanguageSearch(db: Db, user: { claims: JwtClaims; role: string | null }, question: string, api?: AnthropicLike, now = new Date()): Promise<SearchResult> {
  const tables = catalogFor(user.role === "OWNER");
  const res = await guardedParse(db, {
    feature: "NL_SEARCH",
    model: AI_MODELS.draft,
    system: NL_SEARCH_SYSTEM,
    userText: `TODAY (New York): ${nyDate(now)}\n\nTABLES:\n${describeCatalog(tables)}\n\nQUESTION: ${question.slice(0, 500)}`,
    schema: NlSchema,
    airnycLinked: false,
    maxTokens: 3000,
  }, api);
  if (res.status !== "ok") return { status: res.status === "blocked" ? "refused" : "error", reason: res.status === "blocked" ? res.reason : res.error };
  if (!res.output.sql) return { status: "refused", reason: res.output.cannot_answer ?? "That can't be answered from the CRM's data." };
  const v = validateSql(res.output.sql, tables);
  if (!v.ok) return { status: "refused", reason: `The generated query was rejected: ${v.reason}`, sql: res.output.sql };
  try {
    const out = await runReadOnly(db, user.claims, v.sql);
    return { status: "ok", sql: res.output.sql, explanation: res.output.explanation, ...out };
  } catch (e) {
    return { status: "error", reason: (e as { cause?: Error }).cause?.message ?? (e as Error).message, sql: res.output.sql };
  }
}
