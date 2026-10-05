import { OpenAccessSetupError } from "@/lib/auth/open-access";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { MobileNav, SideNav } from "@/components/app-nav";
import { CommandPalette } from "@/components/command-palette";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { inboxReviewWhere, OUTBOX_WAITING } from "@/lib/queues";
import { nyDate, TZ } from "@/lib/time";
import { aiEnabled } from "@/lib/ai/enabled";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  let user;
  try { user = await requireStaff(); }
  catch (error) {
    if (!(error instanceof OpenAccessSetupError)) throw error;
    return <main className="mx-auto max-w-xl space-y-3 p-6"><h1 className="text-xl font-semibold">ESS CRM setup</h1><p>Login is turned off for now.</p><p className="text-sm text-muted-foreground">{error.message}</p></main>;
  }
  // Badge counts for the nav. Run as the user, so RLS hides what they can't open (e.g. priced drafts from a VA).
  const counts = await user.db(async (tx) => {
    // Tasks badge = mine or unassigned, due today or overdue (undated tasks don't nag).
    const [tasks] = await tx
      .select({ n: count() })
      .from(s.tasks)
      .where(and(isNull(s.tasks.archivedAt), inArray(s.tasks.status, ["OPEN", "IN_PROGRESS"]), or(eq(s.tasks.assignee, user.id), isNull(s.tasks.assignee)), sql`(${s.tasks.dueAt} at time zone ${TZ})::date <= ${nyDate(new Date())}::date`));
    const [inbox] = await tx.select({ n: count() }).from(s.activities).where(inboxReviewWhere);
    const [outbox] = await tx.select({ n: count() }).from(s.outboundMessages).where(inArray(s.outboundMessages.status, [...OUTBOX_WAITING]));
    return { tasks: tasks.n, inbox: inbox.n, outbox: outbox.n };
  });
  const nav = { isOwner: user.role === "OWNER", ai: aiEnabled(), counts, name: user.fullName ?? user.email, role: user.openAccess ? "Owner · Open access" : user.role === "OWNER" ? "Owner" : "VA", canSignOut: !user.openAccess };
  return (
    <div className="flex min-h-svh">
      <SideNav {...nav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav {...nav} />
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>
      </div>
      <CommandPalette isOwner={nav.isOwner} ai={nav.ai} />
    </div>
  );
}
