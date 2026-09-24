import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Short-lived signed download link. Both the documents row and the storage object are RLS-checked. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/documents/[id]">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const [doc] = await user.db((tx) => tx.select().from(s.documents).where(eq(s.documents.id, id)));
  if (!doc?.storageBucket || !doc.storagePath) return new NextResponse("Not found", { status: 404 });
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from(doc.storageBucket).createSignedUrl(doc.storagePath, 60);
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
