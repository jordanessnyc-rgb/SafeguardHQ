import { adminDb } from "@/lib/db";
import { mcpFetchHandler } from "@/lib/mcp/http";

// Read-only MCP endpoint for Claude. Auth is a personal access token (Settings → Claude), not the
// Supabase session, so this path is public in the proxy and every request is verified here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = mcpFetchHandler(adminDb);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
