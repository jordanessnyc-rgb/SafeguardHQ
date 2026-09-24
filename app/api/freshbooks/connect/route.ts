import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { authorizeUrl, fbConfigFromEnv } from "@/lib/integrations/freshbooks";
import { siteOrigin } from "@/lib/site";

/** OWNER starts the FreshBooks OAuth flow. A random state in an httpOnly cookie guards the callback. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (user?.role !== "OWNER") return NextResponse.redirect(`${siteOrigin(req.headers)}/`);
  const cfg = fbConfigFromEnv();
  if (!cfg) return NextResponse.redirect(`${siteOrigin(req.headers)}/settings/freshbooks?error=${encodeURIComponent("Set FRESHBOOKS_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI first.")}`);
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(authorizeUrl(cfg, state));
  res.cookies.set("fb_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/freshbooks" });
  return res;
}
