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
import { eventsFromIcs, type ExternalEvent } from "@/lib/calendar/read";

export type CalendarInfo = { url: string; name: string; color: string | null };

// Discovery (a few PROPFINDs) is cached per server process; calendars rarely change.
const DISCOVERY_TTL = 10 * 60_000;
let discovered: { key: string; at: number; calendars: Promise<CalendarInfo[]> } | null = null;

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

  private client() {
    return createDAVClient({
      serverUrl: this.cfg.serverUrl,
      credentials: { username: this.cfg.username, password: this.cfg.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch: this.fetchImpl,
    });
  }

  /** Every event calendar in the mailbox, with Titan's display name and color. */
  async listCalendars(): Promise<CalendarInfo[]> {
    const key = `${this.cfg.serverUrl}|${this.cfg.username}`;
    if (!discovered || discovered.key !== key || Date.now() - discovered.at > DISCOVERY_TTL) {
      const calendars = this.client()
        .then((c) => c.fetchCalendars())
        .then((cals) =>
          cals
            .filter((c) => !c.components || c.components.includes("VEVENT"))
            .map((c) => ({ url: c.url.replace(/\/?$/, "/"), name: String(c.displayName ?? "Calendar").trim(), color: (c as { calendarColor?: string }).calendarColor ?? null })),
        );
      discovered = { key, at: Date.now(), calendars };
      calendars.catch(() => (discovered = null)); // don't cache a failure
    }
    return discovered.calendars;
  }

  /** The collection CRM visits are written to: pinned by settings/env, else by name, else the first. */
  async calendarUrl(): Promise<string> {
    if (this.collection) return this.collection;
    const cals = await this.listCalendars();
    const want = this.cfg.calendarName?.toLowerCase();
    const pick = (want && cals.find((c) => c.name.toLowerCase() === want)) || cals[0];
    if (!pick) throw new Error("No CalDAV calendar found for this Titan mailbox.");
    this.collection = pick.url;
    return this.collection;
  }

  /**
   * Events in [start, end) from the given calendars, repeats expanded. Events the CRM wrote itself
   * (UID …@crm.ess-nyc.com) are left out: the schedule already shows those as jobs.
   */
  async fetchEvents(calendars: CalendarInfo[], range: { start: Date; end: Date }): Promise<ExternalEvent[]> {
    const client = await this.client();
    const lists = await Promise.all(
      calendars.map(async (cal) => {
        const objs = await client.fetchCalendarObjects({ calendar: { url: cal.url }, timeRange: { start: range.start.toISOString(), end: range.end.toISOString() } });
        return objs.flatMap((o) => (typeof o.data === "string" ? eventsFromIcs(o.data, cal, range, { href: new URL(o.url, cal.url).toString(), etag: o.etag ?? null }) : []));
      }),
    );
    return lists.flat().filter((e) => !e.uid.endsWith("@crm.ess-nyc.com")).sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /** One calendar object (an event, or a repeating event with its exceptions) with the ETag to send back on a change. */
  async getObject(href: string): Promise<{ ics: string; etag: string | null }> {
    const res = await this.fetchImpl(href, { method: "GET", headers: { Authorization: this.auth(), Accept: "text/calendar" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404 || res.status === 410) throw new Error("That event is no longer on the calendar (it was deleted in Titan).");
    if (!res.ok) throw new Error(`CalDAV GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ics: await res.text(), etag: res.headers.get("etag") };
  }

  /**
   * Writes an object. With `etag`, the server refuses (412) when the event changed in Titan since it was
   * read; with `create`, it refuses when something already has that name.
   */
  async putObject(href: string, ics: string, opts: { etag?: string | null; create?: boolean } = {}): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = { Authorization: this.auth(), "Content-Type": "text/calendar; charset=utf-8" };
    if (opts.create) headers["If-None-Match"] = "*";
    else if (opts.etag) headers["If-Match"] = opts.etag;
    const res = await this.fetchImpl(href, { method: "PUT", headers, body: ics, signal: AbortSignal.timeout(20_000) });
    if (res.status === 412) throw new Error("This event changed in Titan since the schedule loaded. Reload and try again.");
    if (!res.ok) throw new Error(`CalDAV PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { etag: res.headers.get("etag") };
  }

  async deleteObject(href: string, etag?: string | null): Promise<void> {
    const headers: Record<string, string> = { Authorization: this.auth() };
    if (etag) headers["If-Match"] = etag;
    const res = await this.fetchImpl(href, { method: "DELETE", headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 412) throw new Error("This event changed in Titan since the schedule loaded. Reload and try again.");
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`CalDAV DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  /** The object URL a new event with this UID gets inside a calendar. */
  static objectHref(calendarUrl: string, uid: string): string {
    return new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl.replace(/\/?$/, "/")).toString();
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

/** `calendarUrl` (from Settings → Calendar) overrides the env/auto-picked collection for writes. */
export function titanCalendarFromEnv(calendarUrl?: string | null): TitanCalendar | null {
  const cfg = calendarConfigFromEnv();
  return cfg ? new TitanCalendar(calendarUrl ? { ...cfg, calendarUrl } : cfg) : null;
}
