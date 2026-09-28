"use server";

import { revalidatePath } from "next/cache";
import { and, isNotNull } from "drizzle-orm";
import { adminDb, schema as s } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { safeAction, type ActionState } from "@/lib/actions";
import { titanCalendarFromEnv } from "@/lib/integrations/titan-calendar";

/**
 * Saves which Titan calendars the schedule shows and which one CRM visits are written to. When the
 * write calendar changes, visits already copied to the old one are removed from it and re-written to
 * the new one on the worker's next pass (every 5 minutes).
 */
export async function saveCalendarSettings(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireOwner();
  return safeAction(async () => {
    const titan = titanCalendarFromEnv();
    if (!titan) throw new Error("The Titan calendar isn't connected on the server.");
    const calendars = await titan.listCalendars();
    const urls = new Set(calendars.map((c) => c.url));
    const writeUrl = String(form.get("writeUrl") ?? "");
    if (!urls.has(writeUrl)) throw new Error("Pick the calendar CRM visits should go to.");
    const shown = new Set(form.getAll("show").map(String));
    const hidden = calendars.filter((c) => !shown.has(c.url)).map((c) => c.url);

    const [cfg] = await user.db((tx) => tx.select({ writeUrl: s.settings.calendarWriteUrl }).from(s.settings));
    const oldUrl = cfg?.writeUrl ?? (await titan.calendarUrl());
    let moved = 0;
    let failed = 0;
    if (oldUrl !== writeUrl) {
      // Take CRM visits off the old calendar; the worker re-adds them to the new one.
      const old = titanCalendarFromEnv(oldUrl)!;
      const synced = await adminDb().select({ id: s.jobs.id }).from(s.jobs).where(and(isNotNull(s.jobs.calendarHash)));
      for (const { id } of synced) {
        try {
          await old.remove(`ess-${id}.ics`);
          moved++;
        } catch {
          failed++;
        }
      }
      if (synced.length) await adminDb().update(s.jobs).set({ calendarHash: null }).where(isNotNull(s.jobs.calendarHash));
    }
    await user.db((tx) => tx.update(s.settings).set({ calendarWriteUrl: writeUrl, calendarHiddenUrls: hidden, updatedBy: user.id, updatedAt: new Date() }));
    revalidatePath("/settings/calendar");
    revalidatePath("/schedule");
    const name = calendars.find((c) => c.url === writeUrl)?.name;
    return {
      ok: true,
      message: `Saved. CRM visits go to “${name}”.${moved ? ` ${moved} visit(s) move there within 5 minutes.` : ""}${failed ? ` ${failed} couldn't be removed from the old calendar — delete those by hand.` : ""}`,
    };
  });
}
