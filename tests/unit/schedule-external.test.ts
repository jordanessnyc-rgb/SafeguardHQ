import { describe, expect, it, vi } from "vitest";
import type { ExternalEvent } from "@/lib/calendar/read";
import { loadExternal, toScheduleEvents } from "@/lib/schedule/external";

const cal = { url: "https://dav.example/cal/a/", name: "Jordan Inspection Calendar", color: "#f5a623" };
const ev = (id: string, start: string, end: string, allDay = false): ExternalEvent => ({
  id,
  uid: id,
  calendarUrl: cal.url,
  calendarName: cal.name,
  color: cal.color,
  title: `Event ${id}`,
  description: null,
  recurring: false,
  recurrenceId: null,
  href: `${cal.url}${id}.ics`,
  etag: null,
  location: null,
  start: new Date(start),
  end: new Date(end),
  allDay,
});
const week = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];

describe("toScheduleEvents", () => {
  it("places a timed event at its New York time", () => {
    // 13:00Z on Oct 7 = 9am EDT.
    const [e] = toScheduleEvents([ev("a", "2026-10-07T13:00:00Z", "2026-10-07T14:30:00Z")], week);
    expect(e).toMatchObject({ day: "2026-10-07", minutes: 9 * 60, durationMinutes: 90, allDay: false });
    expect(e.when).toBe("Wed, 10/7, 9am – 10:30am");
  });

  it("splits a multi-day event per day, with fully covered days in the all-day row", () => {
    // Mon 8pm → Wed 10am New York.
    const parts = toScheduleEvents([ev("b", "2026-10-06T00:00:00Z", "2026-10-07T14:00:00Z")], week);
    expect(parts.map((p) => [p.day, p.minutes, p.durationMinutes, p.allDay])).toEqual([
      ["2026-10-05", 20 * 60, 240, false],
      ["2026-10-06", 0, 1440, true],
      ["2026-10-07", 0, 600, false],
    ]);
    expect(new Set(parts.map((p) => p.id)).size).toBe(3);
  });

  it("keeps all-day events on their days and drops ones outside the range", () => {
    const parts = toScheduleEvents(
      [ev("c", "2026-10-09T04:00:00Z", "2026-10-11T04:00:00Z", true), ev("d", "2026-10-20T13:00:00Z", "2026-10-20T14:00:00Z")],
      week,
    );
    expect(parts.map((p) => [p.day, p.allDay])).toEqual([
      ["2026-10-09", true],
      ["2026-10-10", true],
    ]);
    expect(parts[0].when).toBe("Fri, 10/9 – Sat, 10/10, all day");
  });
});

describe("loadExternal", () => {
  const other = { url: "https://dav.example/cal/b/", name: "Personal", color: null };

  it("is empty with no Titan connection", async () => {
    expect(await loadExternal(null, week, [])).toEqual({ calendars: [], events: [], error: null });
  });

  it("skips hidden calendars and asks Titan for the whole range", async () => {
    const fetchEvents = vi.fn(async () => [ev("a", "2026-10-07T13:00:00Z", "2026-10-07T14:00:00Z")]);
    const r = await loadExternal({ listCalendars: async () => [cal, other], fetchEvents }, week, [other.url]);
    expect(r.calendars.map((c) => c.name)).toEqual([cal.name]);
    expect(fetchEvents).toHaveBeenCalledWith([cal], { start: new Date("2026-10-05T04:00:00Z"), end: new Date("2026-10-12T04:00:00Z") });
    expect(r.events).toHaveLength(1);
    expect(r.error).toBeNull();
  });

  it("does not call Titan for events when every calendar is hidden", async () => {
    const fetchEvents = vi.fn();
    const r = await loadExternal({ listCalendars: async () => [cal], fetchEvents }, week, [cal.url]);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(r).toEqual({ calendars: [], events: [], error: null });
  });

  it("turns a Titan failure into a note instead of throwing", async () => {
    const r = await loadExternal({ listCalendars: async () => Promise.reject(new Error("CalDAV 401")), fetchEvents: vi.fn() }, week, []);
    expect(r).toEqual({ calendars: [], events: [], error: "CalDAV 401" });
  });

  it("gives up on a slow Titan", async () => {
    vi.useFakeTimers();
    try {
      const p = loadExternal({ listCalendars: () => new Promise(() => {}), fetchEvents: vi.fn() }, week, []);
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await p).error).toMatch(/too long/);
    } finally {
      vi.useRealTimers();
    }
  });
});
