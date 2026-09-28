import { describe, expect, it } from "vitest";
import { eventsFromIcs } from "@/lib/calendar/read";

const cal = { url: "https://dav.titan.email/principals/me/calendar/1/", name: "Jordan Inspection Calendar", color: "#f5a623" };
const wrap = (body: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test", body, "END:VCALENDAR"].join("\r\n");
const range = { start: new Date("2026-09-28T04:00:00Z"), end: new Date("2026-10-05T04:00:00Z") }; // Mon–Sun, New York

describe("Titan calendar events", () => {
  it("reads a one-off event in New York time, with title and location", () => {
    const ev = eventsFromIcs(
      wrap(["BEGIN:VEVENT", "UID:a1", "SUMMARY:XRF – 12 W 3rd St", "LOCATION:12 W 3rd St\\, Manhattan", "DTSTART;TZID=America/New_York:20260929T090000", "DTEND;TZID=America/New_York:20260929T103000", "END:VEVENT"].join("\r\n")),
      cal,
      range,
    );
    expect(ev).toEqual([expect.objectContaining({ uid: "a1", title: "XRF – 12 W 3rd St", location: "12 W 3rd St, Manhattan", allDay: false, calendarName: "Jordan Inspection Calendar", color: "#f5a623" })]);
    expect(ev[0].start.toISOString()).toBe("2026-09-29T13:00:00.000Z");
    expect(ev[0].end.toISOString()).toBe("2026-09-29T14:30:00.000Z");
  });

  it("uses the event's own time zone (e.g. Puerto Rico, no DST) and UTC times", () => {
    const ev = eventsFromIcs(
      wrap(
        [
          "BEGIN:VEVENT", "UID:pr", "SUMMARY:PR", "DTSTART;TZID=America/Puerto_Rico:20261001T090000", "DTEND;TZID=America/Puerto_Rico:20261001T100000", "END:VEVENT",
          "BEGIN:VEVENT", "UID:utc", "SUMMARY:UTC", "DTSTART:20261002T150000Z", "DURATION:PT45M", "END:VEVENT",
        ].join("\r\n"),
      ),
      cal,
      range,
    );
    const pr = ev.find((e) => e.uid === "pr")!;
    expect(pr.start.toISOString()).toBe("2026-10-01T13:00:00.000Z"); // 9am AST = 13:00Z
    const utc = ev.find((e) => e.uid === "utc")!;
    expect([utc.start.toISOString(), utc.end.toISOString()]).toEqual(["2026-10-02T15:00:00.000Z", "2026-10-02T15:45:00.000Z"]);
  });

  it("expands weekly repeats inside the range, applies an edited occurrence and skips EXDATEs and cancelled events", () => {
    const ev = eventsFromIcs(
      wrap(
        [
          "BEGIN:VEVENT", "UID:weekly", "SUMMARY:Team call", "DTSTART;TZID=America/New_York:20260715T130000", "DTEND;TZID=America/New_York:20260715T133000", "RRULE:FREQ=WEEKLY;BYDAY=WE,FR", "EXDATE;TZID=America/New_York:20261002T130000", "END:VEVENT",
          "BEGIN:VEVENT", "UID:weekly", "RECURRENCE-ID;TZID=America/New_York:20260930T130000", "SUMMARY:Team call (moved)", "DTSTART;TZID=America/New_York:20260930T160000", "DTEND;TZID=America/New_York:20260930T163000", "END:VEVENT",
          "BEGIN:VEVENT", "UID:gone", "SUMMARY:Cancelled", "STATUS:CANCELLED", "DTSTART;TZID=America/New_York:20260929T120000", "DTEND;TZID=America/New_York:20260929T130000", "END:VEVENT",
        ].join("\r\n"),
      ),
      cal,
      range,
    );
    // Wed 9/30 (moved to 4pm); Fri 10/2 excluded by EXDATE.
    expect(ev.map((e) => [e.title, e.start.toISOString()])).toEqual([["Team call (moved)", "2026-09-30T20:00:00.000Z"]]);
  });

  it("handles all-day events and ignores objects it can't parse", () => {
    const ev = eventsFromIcs(wrap(["BEGIN:VEVENT", "UID:ad", "SUMMARY:Office closed", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261002", "END:VEVENT"].join("\r\n")), cal, range);
    expect(ev[0]).toMatchObject({ allDay: true, title: "Office closed" });
    expect(eventsFromIcs("not a calendar", cal, range)).toEqual([]);
  });
});
