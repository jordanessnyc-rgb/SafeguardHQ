import { loginRequired } from "@/lib/auth/access-mode";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { siteOrigin } from "@/lib/site";

export async function POST(request: NextRequest) {
  if (!loginRequired()) return NextResponse.redirect(`${siteOrigin(request.headers)}/`, { status: 303 });
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${siteOrigin(request.headers)}/login`, { status: 303 });
}
