/**
 * Titan calendar events on the CRM schedule. Events are read live from Titan each time the schedule
 * loads (read-only) and turned into New York day + minutes like CRM visits. Multi-day events are split
 * into one piece per day; all-day events go in the all-day row.
 */
import type { ExternalEvent } from "@/lib/calendar/read";
import type { CalendarInfo, TitanCalendar } from "@/lib/integrations/titan-calendar";
import { fromNyInput, toNyInput } from "@/lib/time";
import { shiftDay } from "./load";

export type ScheduleExternal = {
  /** Unique per day piece. */
  id: string;
  calendarUrl: string;
  title: string;
  location: string | null;
  day: string;
  /** Minutes after midnight (0 for all-day); duration clipped to this day. */
  minutes: number;
  durationMinutes: number;
  allDay: boolean;
  /** The whole event's time, e.g. "Mon 10/5, 9am – Tue 10/6, 5pm". */
  when: string;
  /** What the editor needs: the whole event's instants, notes, series info and the CalDAV object. */
  uid: string;
  startIso: string;
  endIso: string;
  description: string | null;
  recurring: boolean;
  recurrenceId: string | null;
  href: string | null;
  etag: string | null;
};

export type ScheduleCalendar = { url: string; name: string; color: string | null };

const clock = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();
const date = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" });

function when(e: ExternalEvent): string {
  if (e.allDay) {
    const lastDay = new Date(e.end.getTime() - 1);
    return toNyInput(e.start).slice(0, 10) === toNyInput(lastDay).slice(0, 10) ? `${date(e.start)}, all day` : `${date(e.start)} – ${date(lastDay)}, all day`;
  }
  const sameDay = toNyInput(e.start).slice(0, 10) === toNyInput(e.end).slice(0, 10);
  return sameDay ? `${date(e.start)}, ${clock(e.start)} – ${clock(e.end)}` : `${date(e.start)}, ${clock(e.start)} – ${date(e.end)}, ${clock(e.end)}`;
}

/** Pieces of each event that fall on the given New York days. */
export function toScheduleEvents(events: ExternalEvent[], days: string[]): ScheduleExternal[] {
  const out: ScheduleExternal[] = [];
  for (const e of events) {
    for (const day of days) {
      const dayStart = fromNyInput(`${day}T00:00`);
      const dayEnd = fromNyInput(`${shiftDay(day, 1)}T00:00`);
      if (e.end <= dayStart || e.start >= dayEnd) continue;
      const from = e.start > dayStart ? e.start : dayStart;
      const to = e.end < dayEnd ? e.end : dayEnd;
      // A timed event covering the whole day (e.g. a trip) reads better in the all-day row too.
      const allDay = e.allDay || (from.getTime() === dayStart.getTime() && to.getTime() === dayEnd.getTime());
      const local = toNyInput(from);
      out.push({
        id: `${e.id}:${day}`,
        calendarUrl: e.calendarUrl,
        title: e.title,
        location: e.location,
        day,
        minutes: allDay ? 0 : Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)),
        durationMinutes: allDay ? 24 * 60 : Math.max(15, Math.round((to.getTime() - from.getTime()) / 60_000)),
        allDay,
        when: when(e),
        uid: e.uid,
        startIso: e.start.toISOString(),
        endIso: e.end.toISOString(),
        description: e.description,
        recurring: e.recurring,
        recurrenceId: e.recurrenceId,
        href: e.href,
        etag: e.etag,
      });
    }
  }
  return out;
}

const TIMEOUT = 8_000;

/**
 * Titan events for the schedule. Never throws: if Titan is slow or down the schedule still loads,
 * with a note instead of the events.
 */
export async function loadExternal(
  titan: Pick<TitanCalendar, "listCalendars" | "fetchEvents"> | null,
  days: string[],
  hiddenUrls: string[],
): Promise<{ calendars: ScheduleCalendar[]; events: ScheduleExternal[]; error: string | null }> {
  if (!titan) return { calendars: [], events: [], error: null };
  const hidden = new Set(hiddenUrls);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const all: CalendarInfo[] = await titan.listCalendars();
      const shown = all.filter((c) => !hidden.has(c.url));
      const events = shown.length ? await titan.fetchEvents(shown, { start: fromNyInput(`${days[0]}T00:00`), end: fromNyInput(`${shiftDay(days[days.length - 1], 1)}T00:00`) }) : [];
      return { calendars: shown.map(({ url, name, color }) => ({ url, name, color })), events: toScheduleEvents(events, days), error: null };
    })();
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Titan took too long to answer")), TIMEOUT)));
    return await Promise.race([work, timeout]);
  } catch (e) {
    return { calendars: [], events: [], error: (e as Error).message || "Couldn't reach Titan" };
  } finally {
    clearTimeout(timer);
  }
}
