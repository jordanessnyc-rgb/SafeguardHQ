import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { siteOrigin } from "@/lib/site";

/**
 * Magic-link / invite landing (Supabase SSR docs, verified 2026-09-24). The email templates must
 * link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<email|invite>` — see
 * docs/RUNBOOK.md. A PKCE `code` is also accepted in case the default templates are still in use.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next") ?? "/";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  const supabase = await createSupabaseServerClient();
  let ok = false;
  if (tokenHash && type) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  return NextResponse.redirect(`${siteOrigin(request.headers)}${ok ? next : "/login?error=link"}`);
}
