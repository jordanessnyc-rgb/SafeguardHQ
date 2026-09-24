/**
 * Titan calendar over CalDAV (SPEC §6.3 "Calendar (Phase 4)"). Verified 2026-09-24 against Titan's
 * help center ("Configure CalDAV"): server https://dav.titan.email (EU: dav-eu.titan.email; GoDaddy
 * "Professional Email": dav.myprofessionalmail.com), HTTP Basic with the mailbox address and its
 * password (an app password when 2FA is on), "Enable Titan on Other Apps" turned on. No public REST
 * API exists. Collections look like /principals/<email>/calendar/<id>/.
 *
 * Discovery (PROPFIND principal → calendar-home-set → calendars) is done once with tsdav unless
 * TITAN_CALDAV_CALENDAR_URL pins the collection; events are written with plain PUT/DELETE of
 * <collection>/<uid>.ics, which is an idempotent upsert.
 */
import { createDAVClient } from "tsdav";

export type CalendarConfig = { serverUrl: string; username: string; password: string; calendarUrl?: string; calendarName?: string };

export function calendarConfigFromEnv(env = process.env): CalendarConfig | null {
  const username = env.TITAN_CALDAV_USERNAME || env.TITAN_USER;
  const password = env.TITAN_CALDAV_PASSWORD || env.TITAN_PASSWORD;
  if (!username || !password || env.TITAN_CALDAV_ENABLED !== "true") return null;
  return {
    serverUrl: env.TITAN_CALDAV_URL || "https://dav.titan.email/principals/",
    username,
    password,
    calendarUrl: env.TITAN_CALDAV_CALENDAR_URL || undefined,
    calendarName: env.TITAN_CALDAV_CALENDAR_NAME || undefined,
  };
}

export type CalendarSink = {
  put(filename: string, ics: string): Promise<void>;
  remove(filename: string): Promise<void>;
};

export class TitanCalendar implements CalendarSink {
  private collection?: string;
  constructor(
    private cfg: CalendarConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.collection = cfg.calendarUrl ? cfg.calendarUrl.replace(/\/?$/, "/") : undefined;
  }

  private auth() {
    return `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64")}`;
  }

  /** The calendar collection URL (discovered once, then cached). */
  async calendarUrl(): Promise<string> {
    if (this.collection) return this.collection;
    const client = await createDAVClient({
      serverUrl: this.cfg.serverUrl,
      credentials: { username: this.cfg.username, password: this.cfg.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: this.fetchImpl,
    });
    const cals = (await client.fetchCalendars()).filter((c) => !c.components || c.components.includes("VEVENT"));
    const want = this.cfg.calendarName?.toLowerCase();
    const pick = (want && cals.find((c) => String(c.displayName ?? "").toLowerCase() === want)) || cals[0];
    if (!pick) throw new Error("No CalDAV calendar found for this Titan mailbox.");
    this.collection = pick.url.replace(/\/?$/, "/");
    return this.collection;
  }

  async put(filename: string, ics: string): Promise<void> {
    const url = new URL(filename, await this.calendarUrl()).toString();
    const res = await this.fetchImpl(url, { method: "PUT", headers: { Authorization: this.auth(), "Content-Type": "text/calendar; charset=utf-8" }, body: ics, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`CalDAV PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async remove(filename: string): Promise<void> {
    const url = new URL(filename, await this.calendarUrl()).toString();
    const res = await this.fetchImpl(url, { method: "DELETE", headers: { Authorization: this.auth() }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`CalDAV DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function titanCalendarFromEnv(): TitanCalendar | null {
  const cfg = calendarConfigFromEnv();
  return cfg ? new TitanCalendar(cfg) : null;
}
