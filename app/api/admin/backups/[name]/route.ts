import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { BACKUP_BUCKET, PREFIX } from "@/lib/backup/export";
import { supabaseService } from "@/lib/supabase/service";

/**
 * Owner-only download of a weekly export from the private `backups` bucket (no Storage policies, so
 * this route's service-role client is the only way in). Every download is written to the audit log:
 * the export holds client records and encrypted AIRnyc fields.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/admin/backups/[name]">) {
  const { name } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (user.role !== "OWNER") return new NextResponse("Forbidden", { status: 403 });
  if (!name.startsWith(PREFIX) || !/^[\w.-]+\.zip$/.test(name)) return new NextResponse("Not found", { status: 404 });
  const { data, error } = await supabaseService().storage.from(BACKUP_BUCKET).createSignedUrl(name, 60, { download: name });
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  await user.db((tx) => tx.insert(s.auditLog).values({ actor: user.id, action: "READ", entity: "backups", entityId: name, detail: { download: true } }));
  return NextResponse.redirect(data.signedUrl);
}
