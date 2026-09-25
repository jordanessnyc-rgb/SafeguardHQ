/** HTTP face of the read-only MCP server: Origin check → personal access token → per-user server. */
import { createMcpHandler, OAuthError, OAuthErrorCode, originValidationResponse, requireBearerAuth, type AuthInfo } from "@modelcontextprotocol/server";
import type { Db } from "@/lib/db";
import { buildMcpServer, type McpUser } from "./server";
import { verifyMcpToken } from "./tokens";

/** Browsers may only call from the CRM's own origin; Claude clients send no Origin header. */
export function allowedOrigins(siteUrl = process.env.NEXT_PUBLIC_SITE_URL): string[] {
  const hosts = ["localhost", "127.0.0.1", "[::1]"];
  try {
    if (siteUrl) hosts.push(new URL(siteUrl).hostname);
  } catch {}
  return hosts;
}

export function mcpFetchHandler(db: () => Db, now: () => Date = () => new Date()) {
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        const user = await verifyMcpToken(db(), token);
        if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown or revoked token");
        // Tokens don't expire on their own (revoke them in Settings); the SDK requires expiresAt, and
        // every request is re-verified against the database anyway.
        return { token, clientId: user.userId, scopes: ["crm:read"], expiresAt: Math.floor(now().getTime() / 1000) + 300, extra: user };
      },
    },
  });
  const handler = createMcpHandler(({ authInfo }) => {
    const user = authInfo?.extra as McpUser | undefined;
    if (!user) throw new Error("MCP request without verified auth"); // unreachable: the gate runs first
    return buildMcpServer(user, db(), now);
  });

  return async (req: Request): Promise<Response> => {
    const rejected = originValidationResponse(req, allowedOrigins());
    if (rejected) return rejected;
    const auth = await gate(req);
    if (auth instanceof Response) return auth;
    return handler.fetch(req, { authInfo: auth });
  };
}
