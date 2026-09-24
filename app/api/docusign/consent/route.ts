import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { consentUrl, docusignConfigFromEnv } from "@/lib/integrations/docusign";
import { siteOrigin } from "@/lib/site";

/** OWNER: one-time DocuSign consent for the JWT integration (redirect URI must be registered in DocuSign). */
export async function GET(req: Request) {
  const origin = siteOrigin(req.headers);
  const user = await getCurrentUser();
  if (user?.role !== "OWNER") return NextResponse.redirect(`${origin}/`);
  const cfg = docusignConfigFromEnv();
  if (!cfg) return NextResponse.redirect(`${origin}/settings?docusign=not-configured`);
  return NextResponse.redirect(consentUrl(cfg, `${origin}/settings?docusign=consented`));
}
