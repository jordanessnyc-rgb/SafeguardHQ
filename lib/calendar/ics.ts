/** Minimal RFC 5545 VEVENT builder: text escaping, 75-octet line folding, CRLF line endings. */

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Folds a content line at 75 octets (continuation lines start with one space), never splitting a UTF-8 character. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export type CalEvent = { uid: string; start: Date; end: Date; summary: string; location?: string | null; description?: string | null; url?: string | null; sequence?: number };

/** One event, no ATTENDEE/ORGANIZER — so no calendar server ever sends an invitation to anyone. */
export function buildIcs(e: CalEvent, now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Environmental Safeguard Solutions//ESS CRM//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SEQUENCE:${e.sequence ?? 0}`,
    `SUMMARY:${esc(e.summary)}`,
    e.location ? `LOCATION:${esc(e.location)}` : null,
    e.description ? `DESCRIPTION:${esc(e.description)}` : null,
    e.url ? `URL:${e.url}` : null,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null);
  return lines.map(fold).join("\r\n") + "\r\n";
}
