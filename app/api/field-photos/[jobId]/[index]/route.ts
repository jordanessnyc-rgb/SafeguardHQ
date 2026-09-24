import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Photo = { path: string };

/** Short-lived signed link to a field photo. field_data and the storage object are RLS-checked. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/field-photos/[jobId]/[index]">) {
  const { jobId, index } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const [fd] = await user.db((tx) => tx.select({ photos: s.fieldData.photos }).from(s.fieldData).where(eq(s.fieldData.jobId, jobId)));
  const photo = (fd?.photos as Photo[] | undefined)?.[Number(index)];
  if (!photo) return new NextResponse("Not found", { status: 404 });
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from("job-files").createSignedUrl(photo.path, 60);
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
