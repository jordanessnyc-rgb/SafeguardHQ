"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { schema as s } from "@/lib/db";
import { requireStaff } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { deleteOccurrenceIcs, newEventIcs, updateEventIcs } from "@/lib/calendar/edit";
import { TitanCalendar, titanCalendarFromEnv } from "@/lib/integrations/titan-calendar";
import { fromNyInput } from "@/lib/time";

/**
 * Jordan's Titan calendars, edited from the CRM schedule: new events, changes, moves and deletes go
 * straight to Titan over CalDAV (the schedule reads them back live). Only calendars the mailbox owns
 * can be written to, and every change is audit-logged. Events have no attendees, so nothing is sent
 * to anyone (CLAUDE.md rule 6).
 */

const ny = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use a date and time.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date.");

const timing = z.discriminatedUnion("allDay", [
  z.object({ allDay: z.literal(false), start: ny, end: ny }),
  // All-day: first and last day, inclusive.
  z.object({ allDay: z.literal(true), startDay: day, endDay: day }),
]);

const text = z.object({
  title: z.string().trim().min(1, "Give the event a title.").max(200),
  location: z.string().trim().max(500).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});

/** Timing → instants. All-day ends are exclusive (midnight after the last day), as iCalendar wants. */
function instants(t: z.infer<typeof timing>): { start: Date; end: Date; allDay: boolean } {
  if (t.allDay) {
    const start = fromNyInput(`${t.startDay}T00:00`);
    const end = new Date(fromNyInput(`${t.endDay}T00:00`).getTime() + 86_400_000);
    if (end <= start) throw new Error("The last day is before the first day.");
    return { start, end, allDay: true };
  }
  const start = fromNyInput(t.start);
  const end = fromNyInput(t.end);
  if (end <= start) throw new Error("The event ends before it starts.");
  return { start, end, allDay: false };
}

async function titanFor(calendarUrl: string) {
  const titan = titanCalendarFromEnv();
  if (!titan) throw new Error("The Titan calendar isn't connected on the server (TITAN_CALDAV_ENABLED).");
  const cal = (await titan.listCalendars()).find((c) => c.url === calendarUrl);
  if (!cal) throw new Error("That calendar isn't one of yours.");
  return { titan, cal };
}

const createInput = z.object({ calendarUrl: z.url(), timing, ...text.shape });

export async function createCalendarEvent(raw: z.input<typeof createInput>): Promise<ActionState & { href?: string }> {
  const user = await requireStaff();
  let href: string | undefined;
  const res = await safeAction(async () => {
    const v = createInput.parse(raw);
    const { titan, cal } = await titanFor(v.calendarUrl);
    const { uid, ics } = newEventIcs({ title: v.title, location: v.location ?? null, description: v.description ?? null, ...instants(v.timing) });
    href = TitanCalendar.objectHref(cal.url, uid);
    await titan.putObject(href, ics, { create: true });
    await user.db((tx) => tx.insert(s.auditLog).values({ actor: user.id, action: "INSERT", entity: "titan_event", entityId: uid, detail: { calendar: cal.name, title: v.title } }));
    return { ok: true, message: `Added to ${cal.name}.` };
  });
  revalidatePath("/schedule");
  return res.error ? res : { ...res, href };
}

const target = z.object({
  calendarUrl: z.url(),
  href: z.url(),
  etag: z.string().nullable().optional(),
  /** For a repeating event: which occurrence (its original instant) and whether the change is for it alone or the series. */
  recurrenceId: z.iso.datetime().nullable().optional(),
  scope: z.enum(["one", "all"]).default("one"),
  currentStart: z.iso.datetime(),
  currentEnd: z.iso.datetime(),
});

const updateInput = target.extend({ timing: timing.optional(), ...text.partial().shape });

/** Change title/where/notes/time, or just move it (drag). */
export async function updateCalendarEvent(raw: z.input<typeof updateInput>): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = updateInput.parse(raw);
    const { titan, cal } = await titanFor(v.calendarUrl);
    if (!v.href.startsWith(cal.url)) throw new Error("That event isn't in this calendar.");
    const { ics, etag } = await titan.getObject(v.href);
    const when = v.timing ? instants(v.timing) : {};
    const next = updateEventIcs(
      ics,
      { title: v.title, location: v.location, description: v.description, ...when },
      { recurrenceId: v.recurrenceId ? new Date(v.recurrenceId) : null, scope: v.scope, currentStart: new Date(v.currentStart), currentEnd: new Date(v.currentEnd) },
    );
    await titan.putObject(v.href, next, { etag: etag ?? v.etag ?? null });
    await user.db((tx) => tx.insert(s.auditLog).values({ actor: user.id, action: "UPDATE", entity: "titan_event", entityId: v.href, detail: { calendar: cal.name, scope: v.recurrenceId ? v.scope : "single", fields: Object.keys(raw).filter((k) => ["title", "location", "description", "timing"].includes(k)) } }));
    return { ok: true, message: v.recurrenceId && v.scope === "all" ? "Whole series changed in Titan." : "Changed in Titan." };
  });
  revalidatePath("/schedule");
  return res;
}

const deleteInput = target.pick({ calendarUrl: true, href: true, etag: true, recurrenceId: true, scope: true });

/** Delete an event, one occurrence of a series (EXDATE), or the whole series. */
export async function deleteCalendarEvent(raw: z.input<typeof deleteInput>): Promise<ActionState> {
  const user = await requireStaff();
  const res = await safeAction(async () => {
    const v = deleteInput.parse(raw);
    const { titan, cal } = await titanFor(v.calendarUrl);
    if (!v.href.startsWith(cal.url)) throw new Error("That event isn't in this calendar.");
    if (v.recurrenceId && v.scope === "one") {
      const { ics, etag } = await titan.getObject(v.href);
      await titan.putObject(v.href, deleteOccurrenceIcs(ics, new Date(v.recurrenceId)), { etag: etag ?? v.etag ?? null });
    } else {
      await titan.deleteObject(v.href, v.etag ?? null);
    }
    await user.db((tx) => tx.insert(s.auditLog).values({ actor: user.id, action: "DELETE", entity: "titan_event", entityId: v.href, detail: { calendar: cal.name, scope: v.recurrenceId ? v.scope : "single" } }));
    return { ok: true, message: v.recurrenceId && v.scope === "one" ? "That occurrence is off the calendar." : "Deleted from Titan." };
  });
  revalidatePath("/schedule");
  return res;
}
