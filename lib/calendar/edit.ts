/**
 * Editing Titan calendar objects in place. Titan speaks plain CalDAV, so a change is: GET the object,
 * rewrite the VEVENT with ical.js, PUT it back (If-Match on the ETag so a change made in Titan in
 * the meantime isn't overwritten). Repeating events are handled the iCalendar way: one occurrence
 * changes through an exception VEVENT (RECURRENCE-ID), a deleted occurrence through EXDATE, and
 * "all events" edits the master. Nothing here adds ATTENDEE/ORGANIZER, so no invitations go out.
 */
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { toDate } from "./read";

export type EventFields = {
  title?: string;
  location?: string | null;
  description?: string | null;
  /** New start/end (timed: instants; all-day: midnight New York of the first day and of the day after the last). */
  start?: Date;
  end?: Date;
  allDay?: boolean;
};

const PRODID = "-//Environmental Safeguard Solutions//ESS CRM//EN";
const nowStamp = () => ICAL.Time.fromJSDate(new Date(), true);

function timeFor(d: Date, allDay: boolean): ICAL.Time {
  if (!allDay) return ICAL.Time.fromJSDate(d, true);
  // All-day: the New York calendar date.
  const ny = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const t = ICAL.Time.fromDateString(ny);
  t.isDate = true;
  return t;
}

/** ical.js doesn't write TZID itself, so a zoned time (from the master's DTSTART) is given its zone here. */
function setTime(v: ICAL.Component, name: "dtstart" | "dtend" | "recurrence-id", t: ICAL.Time, tzid?: string | null) {
  v.removeAllProperties(name);
  if (name !== "recurrence-id") v.removeAllProperties("duration");
  const p = v.addPropertyWithValue(name, t);
  if (!t.isDate && tzid && t.zone?.tzid !== "UTC") p.setParameter("tzid", tzid);
}

function setText(v: ICAL.Component, name: string, value: string | null | undefined) {
  if (value === undefined) return;
  v.removeAllProperties(name);
  if (value !== null && value.trim() !== "") v.addPropertyWithValue(name, value.trim());
}

function applyFields(v: ICAL.Component, f: EventFields) {
  setText(v, "summary", f.title);
  setText(v, "location", f.location);
  setText(v, "description", f.description);
  if (f.start && f.end) {
    const allDay = f.allDay ?? (v.getFirstPropertyValue("dtstart") as ICAL.Time | null)?.isDate ?? false;
    setTime(v, "dtstart", timeFor(f.start, allDay));
    setTime(v, "dtend", timeFor(f.end, allDay));
  }
  const seq = Number(v.getFirstPropertyValue("sequence") ?? 0) + 1;
  v.removeAllProperties("sequence");
  v.addPropertyWithValue("sequence", seq);
  v.removeAllProperties("dtstamp");
  v.addPropertyWithValue("dtstamp", nowStamp());
  v.removeAllProperties("last-modified");
  v.addPropertyWithValue("last-modified", nowStamp());
}

/** A brand-new object with one VEVENT. Returns the ICS and the UID (the object is stored as <uid>.ics). */
export function newEventIcs(f: Required<Pick<EventFields, "title" | "start" | "end" | "allDay">> & Pick<EventFields, "location" | "description">, uid = `${randomUUID()}@ess-nyc.com`): { uid: string; ics: string } {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("prodid", PRODID);
  root.addPropertyWithValue("calscale", "GREGORIAN");
  const v = new ICAL.Component("vevent");
  v.addPropertyWithValue("uid", uid);
  v.addPropertyWithValue("created", nowStamp());
  v.addPropertyWithValue("transp", "OPAQUE");
  applyFields(v, f);
  v.removeAllProperties("sequence");
  v.addPropertyWithValue("sequence", 0);
  root.addSubcomponent(v);
  return { uid, ics: root.toString() };
}

function parse(ics: string): { root: ICAL.Component; master: ICAL.Component; tzid: string | null } {
  const root = new ICAL.Component(ICAL.parse(ics));
  const master = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
  if (!master) throw new Error("This calendar object has no editable event.");
  const tzid = (master.getFirstProperty("dtstart")?.getParameter("tzid") as string | undefined) ?? null;
  return { root, master, tzid };
}

/** The ICAL.Time of the occurrence originally scheduled at `recurrenceId` (as the server wrote it, same zone as the master). */
function occurrenceTime(master: ICAL.Component, tzid: string | null, recurrenceId: Date): ICAL.Time {
  const e = new ICAL.Event(master, { strictExceptions: false });
  const it = e.iterator();
  for (let n = 0, next = it.next(); next && n < 2000; n++, next = it.next()) {
    const at = toDate(next, tzid);
    if (Math.abs(at.getTime() - recurrenceId.getTime()) < 60_000) return next;
    if (at > recurrenceId) break;
  }
  throw new Error("That occurrence isn't in the series any more (it may have been changed in Titan). Reload and try again.");
}

const exceptionFor = (root: ICAL.Component, master: ICAL.Component, rid: ICAL.Time) =>
  root.getAllSubcomponents("vevent").find((v) => v.getFirstPropertyValue("uid") === master.getFirstPropertyValue("uid") && v.hasProperty("recurrence-id") && (v.getFirstPropertyValue("recurrence-id") as ICAL.Time).compare(rid) === 0);

/**
 * Change an event. `scope` matters only for a repeating event: "one" changes that occurrence
 * (an exception VEVENT), "all" changes the master — text as given, and times shifted by the same
 * amount the occurrence moved, so "move the weekly call to 4pm" moves the whole series.
 */
export function updateEventIcs(ics: string, f: EventFields, occurrence?: { recurrenceId: Date | null; scope: "one" | "all"; currentStart: Date; currentEnd: Date }): string {
  const { root, master, tzid } = parse(ics);
  const recurring = master.hasProperty("rrule") || master.hasProperty("rdate");
  if (!recurring || !occurrence?.recurrenceId) {
    applyFields(master, f);
    return root.toString();
  }
  const rid = occurrenceTime(master, tzid, occurrence.recurrenceId);
  if (occurrence.scope === "one") {
    let ex = exceptionFor(root, master, rid);
    if (!ex) {
      ex = new ICAL.Component("vevent");
      for (const name of ["uid", "summary", "location", "description", "transp", "class"]) {
        const v = master.getFirstPropertyValue(name);
        if (v != null) ex.addPropertyWithValue(name, v);
      }
      setTime(ex, "recurrence-id", rid, tzid);
      setTime(ex, "dtstart", timeFor(occurrence.currentStart, rid.isDate));
      setTime(ex, "dtend", timeFor(occurrence.currentEnd, rid.isDate));
      root.addSubcomponent(ex);
    }
    applyFields(ex, { ...f, allDay: rid.isDate });
    return root.toString();
  }
  // Whole series: text on the master; times shifted by how far this occurrence was moved.
  const text: EventFields = { title: f.title, location: f.location, description: f.description };
  if (f.start && f.end) {
    const deltaStart = f.start.getTime() - occurrence.currentStart.getTime();
    const deltaEnd = f.end.getTime() - occurrence.currentEnd.getTime();
    const ms = toDate(master.getFirstPropertyValue("dtstart") as ICAL.Time, tzid);
    const me = (master.getFirstPropertyValue("dtend") as ICAL.Time | null) ? toDate(master.getFirstPropertyValue("dtend") as ICAL.Time, tzid) : new Date(ms.getTime() + (occurrence.currentEnd.getTime() - occurrence.currentStart.getTime()));
    const allDay = (master.getFirstPropertyValue("dtstart") as ICAL.Time).isDate;
    if (allDay) {
      // Keep as dates: shift by whole days.
      const days = Math.round(deltaStart / 86_400_000);
      const len = Math.round((f.end.getTime() - f.start.getTime()) / 86_400_000);
      const s = (master.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
      s.addDuration(ICAL.Duration.fromSeconds(days * 86_400));
      const e = s.clone();
      e.addDuration(ICAL.Duration.fromSeconds(Math.max(1, len) * 86_400));
      applyFields(master, text);
      setTime(master, "dtstart", s);
      setTime(master, "dtend", e);
    } else {
      // Keep the master's zone: shift its wall-clock time by the delta.
      const s = (master.getFirstPropertyValue("dtstart") as ICAL.Time).clone();
      s.addDuration(ICAL.Duration.fromSeconds(Math.round(deltaStart / 1000)));
      const e = s.clone();
      e.addDuration(ICAL.Duration.fromSeconds(Math.round((me.getTime() + deltaEnd - (ms.getTime() + deltaStart)) / 1000)));
      applyFields(master, text);
      const p1 = master.getFirstProperty("dtstart")!;
      p1.setValue(s);
      master.removeAllProperties("dtend");
      master.removeAllProperties("duration");
      const p2 = master.addPropertyWithValue("dtend", e);
      if (tzid) p2.setParameter("tzid", tzid);
    }
    // The exceptions were made against the old times; they keep their own times but stay attached.
    for (const ex of root.getAllSubcomponents("vevent").filter((v) => v.hasProperty("recurrence-id"))) {
      if (!allDay) {
        const r = (ex.getFirstPropertyValue("recurrence-id") as ICAL.Time).clone();
        r.addDuration(ICAL.Duration.fromSeconds(Math.round(deltaStart / 1000)));
        ex.getFirstProperty("recurrence-id")!.setValue(r);
      }
    }
    return root.toString();
  }
  applyFields(master, text);
  return root.toString();
}

/**
 * Delete. For a repeating event, "one" adds an EXDATE (and drops that occurrence's exception);
 * "all" means the caller should DELETE the whole object instead, and this returns null.
 */
export function deleteOccurrenceIcs(ics: string, recurrenceId: Date): string {
  const { root, master, tzid } = parse(ics);
  const rid = occurrenceTime(master, tzid, recurrenceId);
  const ex = exceptionFor(root, master, rid);
  if (ex) root.removeSubcomponent(ex);
  const p = master.addPropertyWithValue("exdate", rid);
  if (!rid.isDate && tzid && rid.zone?.tzid !== "UTC") p.setParameter("tzid", tzid);
  const seq = Number(master.getFirstPropertyValue("sequence") ?? 0) + 1;
  master.removeAllProperties("sequence");
  master.addPropertyWithValue("sequence", seq);
  master.removeAllProperties("dtstamp");
  master.addPropertyWithValue("dtstamp", nowStamp());
  return root.toString();
}

/** Is there anything left of a series after EXDATEs? (Used to delete the object outright when the last occurrence goes.) */
export function isRecurringIcs(ics: string): boolean {
  const { master } = parse(ics);
  return master.hasProperty("rrule") || master.hasProperty("rdate");
}
