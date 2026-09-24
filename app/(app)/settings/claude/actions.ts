"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { createMcpToken } from "@/lib/mcp/tokens";

const PATH = "/settings/claude";

/** Creates a personal access token for the MCP server. The token is returned once and never stored. */
export async function createToken(_prev: ActionState & { token?: string }, form: FormData): Promise<ActionState & { token?: string }> {
  const user = await requireStaff();
  const parsed = z.string().trim().min(1, "Give the token a name, e.g. “Jordan’s laptop”.").max(80).safeParse(form.get("label"));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const res = await safeAction(async () => {
    const token = await user.db((tx) => createMcpToken(tx, user.id, parsed.data)); // RLS: own tokens only
    return { ok: true, token } as ActionState;
  });
  revalidatePath(PATH);
  return res;
}

export async function revokeToken(id: string): Promise<void> {
  const user = await requireStaff();
  await user.db((tx) => tx.update(s.mcpTokens).set({ revokedAt: new Date() }).where(eq(s.mcpTokens.id, id)));
  revalidatePath(PATH);
}
