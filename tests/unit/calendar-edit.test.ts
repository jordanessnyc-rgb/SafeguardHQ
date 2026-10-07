import { describe, expect, it } from "vitest";
import { deleteOccurrenceIcs, newEventIcs, updateEventIcs } from "@/lib/calendar/edit";
import { eventsFromIcs } from "@/lib/calendar/read";

const cal = { url: "https://dav.titan.email/principals/me/calendar/1/", name: "Jordan", color: null };
const range = { start: new Date("2026-09-28T04:00:00Z"), end: new Date("2026-10-26T04:00:00Z") };
const wrap = (body: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test", body, "END:VCALENDAR"].join("\r\n");
const read = (ics: string) => eventsFromIcs(ics, cal, range).map((e) => ({ title: e.title, start: e.start.toISOString(), end: e.end.toISOString(), allDay: e.allDay, location: e.location, description: e.description, recurring: e.recurring, recurrenceId: e.recurrenceId }));

describe("newEventIcs", () => {
  it("writes a timed event in UTC with no attendees", () => {
    const { uid, ics } = newEventIcs({ title: "Site walk; 5 W 6th", start: new Date("2026-10-01T13:00:00Z"), end: new Date("2026-10-01T14:30:00Z"), allDay: false, location: "5 W 6th St, Manhattan", description: "Bring the XRF\nand a ladder" });
    expect(uid).toMatch(/@ess-nyc\.com$/);
    expect(ics).toContain("DTSTART:20261001T130000Z");
    expect(ics).toContain("DTEND:20261001T143000Z");
    expect(ics).not.toMatch(/ATTENDEE|ORGANIZER/);
    expect(read(ics)).toEqual([{ title: "Site walk; 5 W 6th", start: "2026-10-01T13:00:00.000Z", end: "2026-10-01T14:30:00.000Z", allDay: false, location: "5 W 6th St, Manhattan", description: "Bring the XRF\nand a ladder", recurring: false, recurrenceId: null }]);
  });
  it("writes an all-day event as dates (end exclusive)", () => {
    const { ics } = newEventIcs({ title: "Out", start: new Date("2026-10-05T04:00:00Z"), end: new Date("2026-10-07T04:00:00Z"), allDay: true });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261005");
    expect(ics).toContain("DTEND;VALUE=DATE:20261007");
    expect(read(ics)[0]).toMatchObject({ allDay: true, start: "2026-10-05T04:00:00.000Z", end: "2026-10-07T04:00:00.000Z" });
  });
});

describe("updateEventIcs", () => {
  const single = wrap(["BEGIN:VEVENT", "UID:a1", "SEQUENCE:2", "SUMMARY:Old", "DTSTART;TZID=America/New_York:20260929T090000", "DTEND;TZID=America/New_York:20260929T103000", "END:VEVENT"].join("\r\n"));
  it("changes a one-off event's text and time and bumps SEQUENCE", () => {
    const out = updateEventIcs(single, { title: "New", location: "Queens", start: new Date("2026-09-30T14:00:00Z"), end: new Date("2026-09-30T15:00:00Z") });
    expect(out).toContain("SEQUENCE:3");
    expect(out).toContain("UID:a1");
    expect(read(out)).toEqual([expect.objectContaining({ title: "New", location: "Queens", start: "2026-09-30T14:00:00.000Z", end: "2026-09-30T15:00:00.000Z" })]);
  });
  it("leaves fields alone when they're not given, and clears one set to null", () => {
    const out = updateEventIcs(wrap(["BEGIN:VEVENT", "UID:a2", "SUMMARY:Keep", "LOCATION:Here", "DESCRIPTION:Notes", "DTSTART:20261001T130000Z", "DTEND:20261001T140000Z", "END:VEVENT"].join("\r\n")), { location: null });
    expect(read(out)[0]).toMatchObject({ title: "Keep", location: null, description: "Notes", start: "2026-10-01T13:00:00.000Z" });
  });

  const weekly = wrap(["BEGIN:VEVENT", "UID:w", "SUMMARY:Team call", "DTSTART;TZID=America/New_York:20260715T130000", "DTEND;TZID=America/New_York:20260715T133000", "RRULE:FREQ=WEEKLY;BYDAY=WE", "END:VEVENT"].join("\r\n"));
  const occ = { recurrenceId: new Date("2026-10-07T17:00:00Z"), currentStart: new Date("2026-10-07T17:00:00Z"), currentEnd: new Date("2026-10-07T17:30:00Z") }; // Wed Oct 7, 1pm NY

  it("moves one occurrence of a series with an exception, leaving the others", () => {
    const out = updateEventIcs(weekly, { title: "Team call (moved)", start: new Date("2026-10-07T20:00:00Z"), end: new Date("2026-10-07T20:45:00Z") }, { ...occ, scope: "one" });
    expect(out).toContain("RECURRENCE-ID;TZID=America/New_York:20261007T130000");
    const ev = read(out);
    expect(ev.map((e) => [e.title, e.start])).toEqual([
      ["Team call", "2026-09-30T17:00:00.000Z"],
      ["Team call (moved)", "2026-10-07T20:00:00.000Z"],
      ["Team call", "2026-10-14T17:00:00.000Z"],
      ["Team call", "2026-10-21T17:00:00.000Z"],
    ]);
    expect(ev[1]).toMatchObject({ recurring: true, recurrenceId: "2026-10-07T17:00:00.000Z", end: "2026-10-07T20:45:00.000Z" });
    // Editing the same occurrence again reuses the exception rather than adding a second one.
    const again = updateEventIcs(out, { title: "Again" }, { ...occ, scope: "one" });
    expect(again.match(/RECURRENCE-ID/g)).toHaveLength(1);
    expect(read(again)[1].title).toBe("Again");
  });

  it("shifts the whole series when one occurrence is moved with scope all", () => {
    const out = updateEventIcs(weekly, { title: "Team call", start: new Date("2026-10-07T20:00:00Z"), end: new Date("2026-10-07T21:00:00Z") }, { ...occ, scope: "all" });
    expect(out).toContain("DTSTART;TZID=America/New_York:20260715T160000");
    expect(out).toContain("DTEND;TZID=America/New_York:20260715T170000");
    expect(out).not.toContain("RECURRENCE-ID");
    expect(read(out).map((e) => e.start)).toEqual(["2026-09-30T20:00:00.000Z", "2026-10-07T20:00:00.000Z", "2026-10-14T20:00:00.000Z", "2026-10-21T20:00:00.000Z"]);
  });

  it("refuses an occurrence that isn't in the series", () => {
    expect(() => updateEventIcs(weekly, { title: "x" }, { ...occ, recurrenceId: new Date("2026-10-08T17:00:00Z"), scope: "one" })).toThrow(/isn't in the series/);
  });

  it("removes one occurrence with EXDATE", () => {
    const out = deleteOccurrenceIcs(weekly, new Date("2026-10-07T17:00:00Z"));
    expect(out).toContain("EXDATE;TZID=America/New_York:20261007T130000");
    expect(read(out).map((e) => e.start)).toEqual(["2026-09-30T17:00:00.000Z", "2026-10-14T17:00:00.000Z", "2026-10-21T17:00:00.000Z"]);
  });
});
