import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { supabaseService } from "@/lib/supabase/service";

/**
 * A released sub copy for the signed-in subcontractor. Access is decided by the sub_portal_documents
 * view under the user's own identity; only then is a 60-second signed link minted (storage policies
 * don't grant SUB anything directly).
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/portal/documents/[id]">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (user?.role !== "SUB") return new NextResponse("Not found", { status: 404 });
  const [doc] = await user.db((tx) => tx.select().from(s.subPortalDocuments).where(eq(s.subPortalDocuments.id, id)));
  if (!doc?.storagePath || doc.storageBucket !== "job-files") return new NextResponse("Not found", { status: 404 });
  const { data, error } = await supabaseService().storage.from("job-files").createSignedUrl(doc.storagePath, 60);
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
