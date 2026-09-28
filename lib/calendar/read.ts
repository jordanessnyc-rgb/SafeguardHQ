/**
 * Reading Jordan's existing Titan calendars (CalDAV) so the CRM schedule shows everything he already has
 * booked. Titan returns raw VEVENTs (it ignores CalDAV "expand"), so repeating events, their edited
 * occurrences (RECURRENCE-ID), EXDATEs and per-event time zones are handled here with ical.js.
 * Read-only: nothing here writes to Titan.
 */
import ICAL from "ical.js";
import { fromZonedParts, TZ } from "@/lib/time";

export type ExternalEvent = {
  /** Unique per occurrence: uid + start. */
  id: string;
  uid: string;
  calendarUrl: string;
  calendarName: string;
  color: string | null;
  title: string;
  location: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
};

type Cal = { url: string; name: string; color: string | null };

/** ICAL.Time → Date, honouring its TZID even when the VTIMEZONE wasn't sent. */
function toDate(t: ICAL.Time, tzidHint?: string | null): Date {
  if (t.isDate) return fromZonedParts({ year: t.year, month: t.month, day: t.day }, TZ);
  const tz = t.zone?.tzid === "UTC" ? "UTC" : (t.zone && t.zone.tzid !== "floating" ? t.zone.tzid : null) ?? (t as unknown as { timezone?: string }).timezone ?? tzidHint ?? TZ;
  if (tz === "UTC" || tz === "Z") return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
  return fromZonedParts({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, tz);
}

const MAX_OCCURRENCES = 1000;

export function eventsFromIcs(ics: string, cal: Cal, range: { start: Date; end: Date }): ExternalEvent[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    return []; // one bad object shouldn't hide the rest of the calendar
  }
  const vevents = root.getAllSubcomponents("vevent");
  const exceptions = vevents.filter((v) => v.hasProperty("recurrence-id"));
  const out: ExternalEvent[] = [];
  const push = (e: ICAL.Event, start: ICAL.Time, end: ICAL.Time, tzid: string | null) => {
    const s = toDate(start, tzid);
    let en = toDate(end, tzid);
    if (en <= s) en = new Date(s.getTime() + (start.isDate ? 86_400_000 : 3_600_000));
    if (en <= range.start || s >= range.end) return;
    if (String(e.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    out.push({
      id: `${e.uid}:${s.toISOString()}`,
      uid: e.uid,
      calendarUrl: cal.url,
      calendarName: cal.name,
      color: cal.color,
      title: e.summary?.trim() || "(no title)",
      location: e.location?.trim() || null,
      start: s,
      end: en,
      allDay: start.isDate,
    });
  };

  for (const master of vevents.filter((v) => !v.hasProperty("recurrence-id"))) {
    const e = new ICAL.Event(master, { strictExceptions: false });
    for (const x of exceptions) if (x.getFirstPropertyValue("uid") === e.uid) e.relateException(x);
    const tzid = (master.getFirstProperty("dtstart")?.getParameter("tzid") as string | undefined) ?? null;
    if (!e.isRecurring()) {
      push(e, e.startDate, e.endDate, tzid);
      continue;
    }
    const it = e.iterator();
    for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
      if (toDate(next, tzid) >= range.end) break;
      const d = e.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate, tzid);
    }
  }
  // Edited occurrences whose master isn't in this object (servers sometimes split them).
  for (const x of exceptions) {
    if (vevents.some((v) => !v.hasProperty("recurrence-id") && v.getFirstPropertyValue("uid") === x.getFirstPropertyValue("uid"))) continue;
    const e = new ICAL.Event(x);
    push(e, e.startDate, e.endDate, (x.getFirstProperty("dtstart")?.getParameter("tzid") as string | undefined) ?? null);
  }
  return out;
}
