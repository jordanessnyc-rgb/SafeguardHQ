/** MCP personal access tokens: random, shown once, stored as SHA-256. */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@/lib/db";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createMcpToken(conn: Db | Tx, userId: string, label: string): Promise<string> {
  const token = `ess_mcp_${randomBytes(32).toString("base64url")}`;
  await conn.insert(s.mcpTokens).values({ userId, label, tokenHash: hashToken(token) });
  return token;
}

/** Valid token → its user and role (null for revoked/unknown tokens or users without a staff role). */
export async function verifyMcpToken(db: Db, token: string): Promise<{ userId: string; role: "OWNER" | "VA" } | null> {
  if (!/^ess_mcp_[\w-]{40,}$/.test(token)) return null;
  const [row] = await db
    .select({ id: s.mcpTokens.id, userId: s.mcpTokens.userId, role: s.profiles.role })
    .from(s.mcpTokens)
    .innerJoin(s.profiles, eq(s.profiles.userId, s.mcpTokens.userId))
    .where(and(eq(s.mcpTokens.tokenHash, hashToken(token)), isNull(s.mcpTokens.revokedAt)));
  if (!row || (row.role !== "OWNER" && row.role !== "VA")) return null;
  await db.update(s.mcpTokens).set({ lastUsedAt: new Date() }).where(eq(s.mcpTokens.id, row.id));
  return { userId: row.userId, role: row.role };
}
