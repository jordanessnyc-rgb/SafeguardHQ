/** Titan calendar sync (SPEC §6.3) with an in-memory CalDAV sink, plus the iCalendar builder. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { buildIcs, fold } from "@/lib/calendar/ics";
import { syncCalendar } from "@/lib/calendar/sync";
import { TitanCalendar } from "@/lib/integrations/titan-calendar";
import { hasTestDb, setupTestDb, type TestDb } from "../helpers/db";

describe("iCalendar builder", () => {
  it("escapes text, uses UTC times and CRLF, and has no attendees (so no invitations)", () => {
    const ics = buildIcs({ uid: "j1@crm.ess-nyc.com", start: new Date("2026-09-29T14:00:00Z"), end: new Date("2026-09-29T16:00:00Z"), summary: "Mold assessment, ESS; test", description: "Line 1\nLine 2" }, new Date("2026-09-24T15:00:00Z"));
    expect(ics).toContain("DTSTART:20260929T140000Z\r\n");
    expect(ics).toContain("SUMMARY:Mold assessment\\, ESS\; test\r\n");
    expect(ics).toContain("DESCRIPTION:Line 1\\nLine 2\r\n");
    expect(ics).not.toMatch(/ATTENDEE|ORGANIZER|METHOD/);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
  it("folds long lines at 75 octets without splitting characters", () => {
    const line = `DESCRIPTION:${"é".repeat(60)}`;
    const folded = fold(line);
    for (const l of folded.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });
  it("TitanCalendar PUTs <collection>/<file> with Basic auth; DELETE tolerates 404", async () => {
    const calls: { url: string; method: string; auth: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method!, auth: (init.headers as Record<string, string>).Authorization });
      return new Response("", { status: init.method === "DELETE" ? 404 : 201 });
    }) as unknown as typeof fetch;
    const cal = new TitanCalendar({ serverUrl: "https://dav.titan.email/principals/", username: "crm@ess-nyc.com", password: "pw", calendarUrl: "https://dav.titan.email/principals/crm@ess-nyc.com/calendar/35/" }, f);
    await cal.put("ess-1.ics", "BEGIN:VCALENDAR");
    await cal.remove("ess-1.ics");
    expect(calls).toEqual([
      { url: "https://dav.titan.email/principals/crm@ess-nyc.com/calendar/35/ess-1.ics", method: "PUT", auth: `Basic ${Buffer.from("crm@ess-nyc.com:pw").toString("base64")}` },
      { url: "https://dav.titan.email/principals/crm@ess-nyc.com/calendar/35/ess-1.ics", method: "DELETE", auth: expect.any(String) },
    ]);
  });
});

describe.skipIf(!hasTestDb)("calendar sync (database)", () => {
  let t: TestDb;
  const events = new Map<string, string>();
  let puts = 0;
  const sink = { put: async (f: string, ics: string) => void (events.set(f, ics), puts++), remove: async (f: string) => void events.delete(f) };
  const now = new Date("2026-09-24T15:00:00Z");

  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  it("puts scheduled jobs on the calendar once, updates on change, removes when unscheduled / Lost", async () => {
    const [contact] = await t.db.insert(s.contacts).values({ firstName: "Pat", lastName: "Lee", phones: ["+17185550100"] }).returning();
    const [prop] = await t.db.insert(s.properties).values({ addressLine: "420 CENTRAL PARK WEST", unit: "2E", borough: "Manhattan" }).returning();
    const [job] = await t.db
      .insert(s.jobs)
      .values({ serviceCode: "MOLD_ASSESS", pipelineKey: "INSPECTION", stage: "SCHEDULED", propertyId: prop.id, clientContactId: contact.id, scheduledAt: new Date("2026-09-29T14:00:00Z") })
      .returning();
    await t.db.insert(s.jobFinancials).values({ jobId: job.id, quotedAmount: "650.00" });

    expect(await syncCalendar(t.db, sink, now, "https://crm.example")).toEqual({ written: 1, removed: 0, errors: 0 });
    const ics = events.get(`ess-${job.id}.ics`)!;
    expect(ics).toContain(`SUMMARY:Mold assessment — ${job.jobNumber} — 420 CENTRAL PARK WEST`);
    expect(ics).toContain("LOCATION:420 CENTRAL PARK WEST\\, Apt 2E\\, Manhattan");
    expect(ics).toContain("Client: Pat Lee");
    expect(ics).toContain("DTEND:20260929T160000Z");
    expect(ics).not.toContain("650"); // no pricing on the calendar
    expect(await syncCalendar(t.db, sink, now, "https://crm.example")).toMatchObject({ written: 0 }); // unchanged → no write

    await t.db.update(s.jobs).set({ scheduledAt: new Date("2026-09-30T13:00:00Z") }).where(eq(s.jobs.id, job.id));
    await syncCalendar(t.db, sink, now, "https://crm.example");
    expect(events.get(`ess-${job.id}.ics`)).toContain("DTSTART:20260930T130000Z");
    expect(events.get(`ess-${job.id}.ics`)).toContain("SEQUENCE:1");

    await t.db.update(s.jobs).set({ scheduledAt: null }).where(eq(s.jobs.id, job.id));
    expect(await syncCalendar(t.db, sink, now)).toMatchObject({ removed: 1 });
    expect(events.has(`ess-${job.id}.ics`)).toBe(false);
    const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
    expect(j.calendarHash).toBeNull();
  });

  it("AIRnyc jobs carry no member details; failures are recorded on the job", async () => {
    const [kase] = await t.db.insert(s.airnycCases).values({ caseId: "PHS_0148", network: "PHS" }).returning();
    const [member] = await t.db.insert(s.contacts).values({ firstName: "Ana", lastName: "Lopez", phones: ["+13475550222"] }).returning();
    const [job] = await t.db
      .insert(s.jobs)
      .values({ serviceCode: "AIRNYC", pipelineKey: "INSPECTION", stage: "SCHEDULED", airnycCaseId: kase.id, clientContactId: member.id, scheduledAt: new Date("2026-10-01T14:00:00Z") })
      .returning();
    await syncCalendar(t.db, sink, now);
    const ics = events.get(`ess-${job.id}.ics`)!;
    expect(ics).toContain("AIRnyc case PHS_0148");
    expect(ics).not.toMatch(/Ana|Lopez|347/);

    const broken = { put: async () => { throw new Error("CalDAV PUT 401: unauthorized"); }, remove: async () => {} };
    await t.db.update(s.jobs).set({ scheduledAt: new Date("2026-10-02T14:00:00Z") }).where(eq(s.jobs.id, job.id));
    expect(await syncCalendar(t.db, broken, now)).toMatchObject({ errors: 1 });
    const [j] = await t.db.select().from(s.jobs).where(eq(s.jobs.id, job.id));
    expect(j.calendarError).toBe("CalDAV PUT 401: unauthorized");
  });
});
