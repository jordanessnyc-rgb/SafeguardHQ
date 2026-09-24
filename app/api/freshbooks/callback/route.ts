import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { exchangeCode, fbConfigFromEnv, fetchIdentity, FreshBooksClient, saveConnection } from "@/lib/integrations/freshbooks";
import { registerWebhooks } from "@/lib/money/freshbooks-setup";
import { siteOrigin } from "@/lib/site";

/** FreshBooks redirects here with ?code&state. Saves encrypted tokens, then registers webhooks. */
export async function GET(req: Request) {
  const origin = siteOrigin(req.headers);
  const back = (q: string) => NextResponse.redirect(`${origin}/settings/freshbooks?${q}`);
  const user = await getCurrentUser();
  if (user?.role !== "OWNER") return NextResponse.redirect(`${origin}/`);
  const cfg = fbConfigFromEnv();
  if (!cfg) return back("error=not-configured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const expected = (await cookies()).get("fb_oauth_state")?.value ?? "";
  if (!code || !expected || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return back(`error=${encodeURIComponent("The FreshBooks sign-in expired or didn't match. Try again.")}`);
  }
  try {
    const db = adminDb();
    const tokens = await exchangeCode(cfg, code);
    const identity = await fetchIdentity(tokens.access_token);
    await saveConnection(db, tokens, identity, user.id);
    await registerWebhooks(db, new FreshBooksClient(db, cfg), `${origin}/api/webhooks/freshbooks`);
    const res = back("connected=1");
    res.cookies.delete({ name: "fb_oauth_state", path: "/api/freshbooks" });
    return res;
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message.slice(0, 200))}`);
  }
}
