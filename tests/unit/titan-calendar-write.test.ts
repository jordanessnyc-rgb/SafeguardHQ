import { describe, expect, it, vi } from "vitest";
import { TitanCalendar } from "@/lib/integrations/titan-calendar";

const cfg = { serverUrl: "https://dav.titan.email/principals/", username: "crm@ess-nyc.com", password: "pw" };
const CAL = "https://dav.titan.email/principals/crm%40ess-nyc.com/calendar/abc/";

function fake(status: number, body = "", headers: Record<string, string> = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    return new Response(body, { status, headers });
  });
  return { titan: new TitanCalendar(cfg, fetchImpl as unknown as typeof fetch), calls };
}

describe("TitanCalendar objects", () => {
  it("names a new object after its UID inside the calendar", () => {
    expect(TitanCalendar.objectHref(CAL.replace(/\/$/, ""), "a b@ess-nyc.com")).toBe(`${CAL}a%20b%40ess-nyc.com.ics`);
  });
  it("GETs an object with its ETag and sends Basic auth", async () => {
    const { titan, calls } = fake(200, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { etag: '"v1"' });
    expect(await titan.getObject(`${CAL}x.ics`)).toEqual({ ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", etag: '"v1"' });
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("crm@ess-nyc.com:pw").toString("base64")}`);
  });
  it("creates with If-None-Match and updates with If-Match", async () => {
    const { titan, calls } = fake(201, "", { etag: '"v2"' });
    expect(await titan.putObject(`${CAL}x.ics`, "ICS", { create: true })).toEqual({ etag: '"v2"' });
    expect(calls[0].headers["If-None-Match"]).toBe("*");
    expect(calls[0].headers["If-Match"]).toBeUndefined();
    await titan.putObject(`${CAL}x.ics`, "ICS", { etag: '"v1"' });
    expect(calls[1].headers["If-Match"]).toBe('"v1"');
    expect(calls[1].headers["Content-Type"]).toContain("text/calendar");
  });
  it("explains a 412 (changed in Titan meanwhile) and a vanished event", async () => {
    await expect(fake(412).titan.putObject(`${CAL}x.ics`, "ICS", { etag: '"old"' })).rejects.toThrow(/changed in Titan/);
    await expect(fake(412).titan.deleteObject(`${CAL}x.ics`, '"old"')).rejects.toThrow(/changed in Titan/);
    await expect(fake(404).titan.getObject(`${CAL}x.ics`)).rejects.toThrow(/no longer on the calendar/);
    await expect(fake(404).titan.deleteObject(`${CAL}x.ics`)).resolves.toBeUndefined();
  });
});
