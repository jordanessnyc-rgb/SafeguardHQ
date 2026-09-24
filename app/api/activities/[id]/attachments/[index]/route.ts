import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Download an email attachment that isn't (yet) a job document. Access = the user can see the
 * activity under RLS; the file is then served via a 60-second signed URL.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/activities/[id]/attachments/[index]">) {
  const { id, index } = await ctx.params;
  const user = await getCurrentUser();
  if (!user || (user.role !== "OWNER" && user.role !== "VA")) return new NextResponse("Unauthorized", { status: 401 });
  const [a] = await user.db((tx) => tx.select({ attachments: s.activities.attachments }).from(s.activities).where(eq(s.activities.id, id)));
  const att = a?.attachments?.[Number(index)];
  if (!att || (att.ownerOnly && user.role !== "OWNER")) return new NextResponse("Not found", { status: 404 });
  const { data, error } = await supabaseAdmin().storage.from(att.storageBucket).createSignedUrl(att.storagePath, 60, { download: att.filename });
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
