import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { stageRuleMessage } from "@/lib/pipeline/rules";

export type ActionState = { ok?: boolean; error?: string; message?: string };

/** Runs a server action body and turns expected failures into a message for the form. */
export async function safeAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let redirect()/notFound() through
    const stage = stageRuleMessage(e);
    if (stage) return { error: stage };
    if (e instanceof z.ZodError) return { error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    const pg = (e as { cause?: { code?: string; message?: string } }).cause;
    if (pg?.code === "23505") return { error: "That record already exists." };
    if (pg?.code === "42501" || /row-level security/.test(pg?.message ?? "")) {
      return { error: "You don't have permission to do that." };
    }
    console.error(e);
    return { error: (e as Error).message || "Something went wrong." };
  }
}

/** FormData → plain object, turning "" into undefined so optional zod fields work. */
export function formObject(form: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v.trim() === "" ? undefined : v.trim();
  }
  return out;
}

export const optionalUuid = z.uuid().optional();
export const checkbox = z.preprocess((v) => v === "on" || v === "true", z.boolean());
