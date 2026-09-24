/** ESS works in New York time; servers run in UTC. These convert form inputs both ways. */
export const TZ = "America/New_York";

function offsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT-04:00"
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** "2026-10-01" + "10:00" (or "2026-10-01T10:00") as New York wall-clock time → Date. */
export function fromNyInput(value: string, defaultTime = "17:00"): Date {
  const [date, time = defaultTime] = value.split("T");
  const guess = new Date(`${date}T${time.slice(0, 5)}:00Z`);
  const first = new Date(guess.getTime() - offsetMinutes(guess) * 60000);
  // Re-check the offset at the actual instant (matters on DST-change days).
  return new Date(guess.getTime() - offsetMinutes(first) * 60000);
}

/** Date → "YYYY-MM-DDTHH:mm" in New York, for <input type="datetime-local">. */
export function toNyInput(d: Date | null | undefined): string {
  if (!d) return "";
  const local = new Date(d.getTime() + offsetMinutes(d) * 60000);
  return local.toISOString().slice(0, 16);
}

type Hours = Record<string, { open: string; close: string } | null>;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Is `at` inside ESS business hours (settings.business_hours, New York time)? */
export function isWithinBusinessHours(at: Date, hours: Hours): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const day = DAY_KEYS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)];
  const window = hours[day];
  if (!window) return false;
  const hm = `${parts.hour}:${parts.minute}`;
  return hm >= window.open && hm < window.close;
}

/** Date → "YYYY-MM-DD" in New York. */
export function nyDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}
