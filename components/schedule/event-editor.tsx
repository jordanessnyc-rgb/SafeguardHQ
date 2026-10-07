"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleCalendar, ScheduleExternal } from "@/lib/schedule/external";
import { toNyInput } from "@/lib/time";
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "@/app/(app)/schedule/calendar-actions";

export type EditorMode = { kind: "new"; day: string; minutes?: number; calendarUrl?: string } | { kind: "edit"; event: ScheduleExternal };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDays = (day: string, n: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const plusMinutes = (time: string, n: number) => {
  const m = Math.min(23 * 60 + 59, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + n);
  return hhmm(m);
};

type Form = { title: string; calendarUrl: string; allDay: boolean; startDay: string; startTime: string; endDay: string; endTime: string; location: string; description: string; scope: "one" | "all" };

function initial(mode: EditorMode, calendars: ScheduleCalendar[]): Form {
  if (mode.kind === "new") {
    const startTime = hhmm(mode.minutes ?? 9 * 60);
    return { title: "", calendarUrl: mode.calendarUrl ?? calendars[0]?.url ?? "", allDay: false, startDay: mode.day, startTime, endDay: mode.day, endTime: plusMinutes(startTime, 60), location: "", description: "", scope: "one" };
  }
  const e = mode.event;
  const start = toNyInput(new Date(e.startIso));
  const end = toNyInput(new Date(e.endIso));
  const wholeDays = e.allDay && !e.recurring;
  return {
    title: e.title === "(no title)" ? "" : e.title,
    calendarUrl: e.calendarUrl,
    allDay: e.allDay,
    startDay: start.slice(0, 10),
    startTime: e.allDay ? "09:00" : start.slice(11, 16),
    // All-day ends are stored as the day after; show the last day.
    endDay: e.allDay ? addDays(end.slice(0, 10), end.slice(11, 16) === "00:00" ? -1 : 0) : end.slice(0, 10),
    endTime: e.allDay ? "10:00" : end.slice(11, 16),
    location: e.location ?? "",
    description: e.description ?? "",
    scope: wholeDays ? "one" : "one",
  };
}

const timingOf = (f: Form) => (f.allDay ? { allDay: true as const, startDay: f.startDay, endDay: f.endDay } : { allDay: false as const, start: `${f.startDay}T${f.startTime}`, end: `${f.endDay}T${f.endTime}` });

/** Add or change a Titan calendar event from the schedule. Everything goes straight to Titan; the schedule reloads after. */
export function EventEditor({ mode, calendars, onClose, onSaved }: { mode: EditorMode; calendars: ScheduleCalendar[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(() => initial(mode, calendars));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const editing = mode.kind === "edit" ? mode.event : null;
  const recurring = Boolean(editing?.recurring && editing.recurrenceId);
  const calName = calendars.find((c) => c.url === f.calendarUrl)?.name ?? "Titan";
  const set = (patch: Partial<Form>) => setF((cur) => ({ ...cur, ...patch }));

  const save = () =>
    start(async () => {
      const common = { title: f.title, location: f.location || null, description: f.description || null };
      const r = editing
        ? await updateCalendarEvent({
            calendarUrl: editing.calendarUrl,
            href: editing.href!,
            etag: editing.etag,
            recurrenceId: recurring ? editing.recurrenceId : null,
            scope: f.scope,
            currentStart: editing.startIso,
            currentEnd: editing.endIso,
            timing: timingOf(f),
            ...common,
          })
        : await createCalendarEvent({ calendarUrl: f.calendarUrl, timing: timingOf(f), ...common });
      if (r.error) return void toast.error(r.error);
      toast.success(r.message ?? "Saved.");
      onSaved();
      onClose();
    });

  const remove = (scope: "one" | "all") =>
    start(async () => {
      const r = await deleteCalendarEvent({ calendarUrl: editing!.calendarUrl, href: editing!.href!, etag: editing!.etag, recurrenceId: recurring ? editing!.recurrenceId : null, scope });
      if (r.error) return void toast.error(r.error);
      toast.success(r.message ?? "Deleted.");
      onSaved();
      onClose();
    });

  const cantEdit = editing && !editing.href;

  return (
    <Dialog open onOpenChange={(o) => o || onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Change event" : "New calendar event"}</DialogTitle>
          <DialogDescription>{editing ? `${editing.when} · on your Titan calendar "${calName}"` : "Goes straight onto your Titan calendar. No invitations are sent."}</DialogDescription>
        </DialogHeader>
        {cantEdit ? (
          <p className="text-sm text-amber-700">This event can&apos;t be changed from here (Titan didn&apos;t say where it is stored). Change it in Titan.</p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ev-title">Title</Label>
              <Input id="ev-title" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Lead inspection — 120 W 44th" autoFocus />
            </div>
            {!editing && calendars.length > 1 && (
              <div className="grid gap-1.5">
                <Label htmlFor="ev-cal">Calendar</Label>
                <NativeSelect id="ev-cal" value={f.calendarUrl} onChange={(e) => set({ calendarUrl: e.target.value })}>
                  {calendars.map((c) => (
                    <option key={c.url} value={c.url}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={f.allDay} onChange={(e) => set({ allDay: e.target.checked })} /> All day
            </label>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ev-sd">{f.allDay ? "First day" : "Starts"}</Label>
                <div className="grid grid-cols-[1fr_auto] gap-1.5">
                  <Input id="ev-sd" type="date" value={f.startDay} onChange={(e) => set({ startDay: e.target.value, endDay: f.endDay < e.target.value ? e.target.value : f.endDay })} />
                  {!f.allDay && <Input type="time" step={900} value={f.startTime} aria-label="Start time" onChange={(e) => set({ startTime: e.target.value, endTime: f.endDay === f.startDay && f.endTime <= e.target.value ? plusMinutes(e.target.value, 60) : f.endTime })} />}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ev-ed">{f.allDay ? "Last day" : "Ends"}</Label>
                <div className="grid grid-cols-[1fr_auto] gap-1.5">
                  <Input id="ev-ed" type="date" value={f.endDay} min={f.startDay} onChange={(e) => set({ endDay: e.target.value })} />
                  {!f.allDay && <Input type="time" step={900} value={f.endTime} aria-label="End time" onChange={(e) => set({ endTime: e.target.value })} />}
                </div>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ev-loc">Where</Label>
              <Input id="ev-loc" value={f.location} onChange={(e) => set({ location: e.target.value })} placeholder="Address (optional)" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ev-notes">Notes</Label>
              <Textarea id="ev-notes" rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} />
            </div>
            {recurring && (
              <fieldset className="rounded-md border p-2 text-sm">
                <legend className="px-1 text-xs text-muted-foreground">This is a repeating event</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="ev-scope" className="accent-primary" checked={f.scope === "one"} onChange={() => set({ scope: "one" })} /> Change only this one
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="ev-scope" className="accent-primary" checked={f.scope === "all"} onChange={() => set({ scope: "all" })} /> Change every event in the series (times shift by the same amount)
                </label>
              </fieldset>
            )}
          </div>
        )}
        <DialogFooter className="flex-wrap sm:justify-between">
          <span className="flex flex-wrap gap-2">
            {editing && !cantEdit && !confirmDelete && (
              <Button type="button" variant="ghost" className="text-destructive" disabled={pending} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
            {editing && confirmDelete && (
              <>
                <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => remove("one")}>
                  {recurring ? "Delete this one only" : "Yes, delete it"}
                </Button>
                {recurring && (
                  <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => remove("all")}>
                    Delete the whole series
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </Button>
              </>
            )}
          </span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {!cantEdit && (
              <Button type="button" disabled={pending || !f.title.trim() || !f.startDay || !f.endDay} onClick={save}>
                {editing ? "Save to Titan" : "Add to Titan"}
              </Button>
            )}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
