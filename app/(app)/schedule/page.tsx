import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { requireStaff } from "@/lib/auth/session";
import { schema as s } from "@/lib/db";
import { titanCalendarFromEnv } from "@/lib/integrations/titan-calendar";
import { loadExternal } from "@/lib/schedule/external";
import { loadSchedule, scheduleDays, shiftDay } from "@/lib/schedule/load";
import { nyDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ScheduleBoard } from "./schedule-board";

export const metadata = { title: "Schedule" };

const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...o });

export default async function SchedulePage({ searchParams }: PageProps<"/schedule">) {
  const user = await requireStaff();
  const sp = await searchParams;
  const view = sp.view === "day" ? "day" : "week";
  const today = nyDate(new Date());
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const days = scheduleDays(date, view);
  const { data, cfg } = await user.db(async (tx) => ({ data: await loadSchedule(tx, days), cfg: (await tx.select({ hidden: s.settings.calendarHiddenUrls }).from(s.settings))[0] }));
  // Jordan's own Titan events, read live (not stored); a Titan outage only hides them.
  const titan = await loadExternal(titanCalendarFromEnv(), days, cfg?.hidden ?? []);
  const step = view === "day" ? 1 : 7;
  const href = (d: string, v = view) => `/schedule?view=${v}&date=${d}`;
  const title =
    view === "day"
      ? fmt(date, { weekday: "long", month: "long", day: "numeric" })
      : `${fmt(days[0], { month: "short", day: "numeric" })} – ${fmt(days[6], { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <>
      <PageHeader
        title="Schedule"
        description={title}
        actions={
          <>
            <div className="seg">
              <Link href={href(date, "day")} className={cn("seg-item", view === "day" && "seg-on")}>Day</Link>
              <Link href={href(date, "week")} className={cn("seg-item", view === "week" && "seg-on")}>Week</Link>
            </div>
            <div className="flex gap-1">
              <Link href={href(shiftDay(date, -step))} className={buttonVariants({ size: "sm", variant: "outline" })} aria-label={`Previous ${view}`}>‹</Link>
              <Link href={href(today)} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>Today</Link>
              <Link href={href(shiftDay(date, step))} className={buttonVariants({ size: "sm", variant: "outline" })} aria-label={`Next ${view}`}>›</Link>
            </div>
            {view === "day" && <Link href={`/route?date=${date}`} className={buttonVariants({ size: "sm", variant: "outline" })}>Route for this day</Link>}
          </>
        }
      />
      {/* Keyed by the range so the board's local state resets when you change week or day. */}
      <ScheduleBoard key={days.join()} days={days} today={data.today} scheduled={data.scheduled} unscheduled={data.unscheduled} staff={data.staff} meId={user.id}
        external={titan.events}
        calendars={titan.calendars}
        calendarError={titan.error}
        isOwner={user.role === "OWNER"}
      />
    </>
  );
}
