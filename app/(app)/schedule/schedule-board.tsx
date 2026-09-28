"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarPlus, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import type { ScheduleCalendar, ScheduleExternal } from "@/lib/schedule/external";
import type { ScheduleJob } from "@/lib/schedule/load";
import { DURATIONS, durationLabel } from "@/lib/schedule/rules";
import { scheduleJob } from "./actions";

type Staff = { id: string; label: string };

const SLOT = 30; // minutes per row
const ROW = 22; // px per row
const COLORS = [
  "border-l-emerald-700 bg-emerald-50 dark:bg-emerald-950/60",
  "border-l-sky-700 bg-sky-50 dark:bg-sky-950/60",
  "border-l-amber-600 bg-amber-50 dark:bg-amber-950/60",
  "border-l-fuchsia-700 bg-fuchsia-50 dark:bg-fuchsia-950/60",
  "border-l-teal-700 bg-teal-50 dark:bg-teal-950/60",
];
const UNASSIGNED = "border-l-zinc-500 bg-zinc-50 dark:bg-zinc-900";
const SWATCH = ["bg-emerald-700", "bg-sky-700", "bg-amber-600", "bg-fuchsia-700", "bg-teal-700"];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clock = (m: number) => {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${((h + 11) % 12) + 1}${min ? `:${String(min).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};
const dayLabel = (d: string, style: "short" | "long" = "short") =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: style === "long" ? "long" : "short", month: style === "long" ? "long" : "numeric", day: "numeric" });

/** Titan colors come as #rrggbb or #rrggbbaa; anything else gets a neutral grey. */
const calColor = (c: string | null | undefined) => (c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : "#71717a");

type Timed = { id: string; minutes: number | null; durationMinutes: number };

/** Side-by-side lanes for overlapping visits and Titan events on one day. */
function lanes(jobs: Timed[]) {
  const sorted = [...jobs].sort((a, b) => a.minutes! - b.minutes!);
  const out = new Map<string, { lane: number; of: number }>();
  let group: Timed[] = [];
  let groupEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    const lane = new Map<string, number>();
    for (const j of group) {
      let i = ends.findIndex((e) => e <= j.minutes!);
      if (i < 0) i = ends.length;
      ends[i] = j.minutes! + j.durationMinutes;
      lane.set(j.id, i);
    }
    for (const j of group) out.set(j.id, { lane: lane.get(j.id)!, of: ends.length });
    group = [];
  };
  for (const j of sorted) {
    if (group.length && j.minutes! >= groupEnd) flush();
    group.push(j);
    groupEnd = Math.max(groupEnd, j.minutes! + j.durationMinutes);
  }
  if (group.length) flush();
  return out;
}

type Editing = { job: ScheduleJob; day: string; minutes: number; duration: number; assignedTo: string };

export function ScheduleBoard({
  days,
  today,
  scheduled,
  unscheduled,
  staff,
  meId,
  external = [],
  calendars = [],
  calendarError = null,
  isOwner = false,
}: {
  days: string[];
  today: string;
  scheduled: ScheduleJob[];
  unscheduled: ScheduleJob[];
  staff: Staff[];
  meId: string;
  external?: ScheduleExternal[];
  calendars?: ScheduleCalendar[];
  calendarError?: string | null;
  isOwner?: boolean;
}) {
  const router = useRouter();
  const [events, setEvents] = useState(scheduled);
  const [waiting, setWaiting] = useState(unscheduled);
  const [who, setWho] = useState<string>("all");
  const [q, setQ] = useState("");
  const [over, setOver] = useState<{ day: string; minutes: number } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [viewing, setViewing] = useState<ScheduleExternal | null>(null);
  const [offCals, setOffCals] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const color = useMemo(() => new Map(staff.map((u, i) => [u.id, COLORS[i % COLORS.length]])), [staff]);
  const swatch = useMemo(() => new Map(staff.map((u, i) => [u.id, SWATCH[i % SWATCH.length]])), [staff]);
  const cal = useMemo(() => new Map(calendars.map((c) => [c.url, c])), [calendars]);
  const titan = external.filter((e) => !offCals.has(e.calendarUrl));
  const titanTimed = titan.filter((e) => !e.allDay);
  const titanAllDay = titan.filter((e) => e.allDay);
  // Weekends only take room when something is booked then (or it's today).
  const shown = days.length === 1 ? days : days.filter((d, i) => i < 5 || d === today || events.some((e) => e.day === d) || titan.some((e) => e.day === d));
  const visible = events.filter((e) => who === "all" || (who === "none" ? !e.assignedTo : e.assignedTo === who));
  // Show business hours, stretched to fit anything booked earlier or later.
  const timed: Timed[] = [...visible, ...titanTimed];
  const first = Math.min(7 * 60, ...timed.map((e) => Math.floor(e.minutes! / 60) * 60));
  const last = Math.max(19 * 60, ...timed.map((e) => Math.min(24 * 60, Math.ceil((e.minutes! + e.durationMinutes) / 60) * 60)));
  const rows = (last - first) / SLOT;
  const all = [...events, ...waiting];

  const save = (job: ScheduleJob, day: string | null, minutes: number | null, extra: { durationMinutes?: number; assignedTo?: string | null } = {}) => {
    const before = { events, waiting };
    const moved: ScheduleJob = { ...job, day, minutes, durationMinutes: extra.durationMinutes ?? job.durationMinutes, assignedTo: extra.assignedTo !== undefined ? extra.assignedTo : job.assignedTo };
    // Optimistic: show it where it was dropped right away.
    if (day === null) {
      setEvents((l) => l.filter((e) => e.id !== job.id));
      setWaiting((l) => [{ ...moved, calendarError: null }, ...l.filter((e) => e.id !== job.id)]);
    } else {
      setWaiting((l) => l.filter((e) => e.id !== job.id));
      setEvents((l) => (days.includes(day) ? [...l.filter((e) => e.id !== job.id), moved] : l.filter((e) => e.id !== job.id)));
    }
    start(async () => {
      const r = await scheduleJob({ jobId: job.id, start: day && minutes !== null ? `${day}T${hhmm(minutes)}` : null, ...extra });
      if (r.error) {
        setEvents(before.events);
        setWaiting(before.waiting);
        toast.error(`${job.jobNumber}: ${r.error}`);
        return;
      }
      toast.success(
        day
          ? `${job.jobNumber} booked ${dayLabel(day)} at ${clock(minutes!)}${r.stage ? ` · moved to ${job.movesTo ?? "Scheduled"}` : ""}. It shows on the Titan calendar within 5 minutes.`
          : `${job.jobNumber} taken off the schedule.`,
      );
      router.refresh();
    });
  };

  const dropAt = (day: string, e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rect.top) / ROW)));
    return { day, minutes: first + slot * SLOT };
  };

  const open = (job: ScheduleJob, day?: string, minutes?: number) =>
    setEditing({ job, day: job.day ?? day ?? (days.includes(today) ? today : days[0]), minutes: job.minutes ?? minutes ?? 9 * 60, duration: job.durationMinutes, assignedTo: job.assignedTo ?? (job.day ? "" : meId) });

  const filtered = waiting.filter((j) => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const text = `${j.jobNumber} ${j.service} ${j.address ?? ""} ${j.client ?? ""} ${j.stageName}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Show:</span>
          {[{ id: "all", label: "Everyone" }, ...staff, { id: "none", label: "Unassigned" }].map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setWho(u.id)}
              className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1", who === u.id ? "border-primary bg-sidebar-accent font-medium text-primary" : "hover:bg-muted")}
            >
              {u.id !== "all" && <span className={cn("size-2.5 rounded-full", u.id === "none" ? "bg-zinc-500" : swatch.get(u.id))} aria-hidden />}
              {u.label}
            </button>
          ))}
        </div>
        {(calendars.length > 0 || calendarError) && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Titan:</span>
            {calendars.map((c) => {
              const on = !offCals.has(c.url);
              return (
                <button
                  key={c.url}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setOffCals((s) => (s.delete(c.url) ? new Set(s) : new Set(s).add(c.url)))}
                  className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1", on ? "hover:bg-muted" : "text-muted-foreground line-through opacity-60 hover:bg-muted")}
                  title={on ? "Hide these events" : "Show these events"}
                >
                  <span className="size-2.5 rounded-full" style={{ background: calColor(c.color) }} aria-hidden />
                  {c.name}
                </button>
              );
            })}
            {calendarError && (
              <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5" aria-hidden /> Titan events aren&apos;t showing: {calendarError}
              </span>
            )}
            {isOwner && (
              <Link href="/settings/calendar" className="ml-1 text-muted-foreground underline">
                Calendar settings
              </Link>
            )}
          </div>
        )}
        <div className="overflow-x-auto rounded-lg border">
          <div className="grid" style={{ gridTemplateColumns: `3.25rem repeat(${shown.length}, minmax(${shown.length > 1 ? "6.5rem" : "12rem"}, 1fr))`, minWidth: shown.length > 1 ? `${3.25 + shown.length * 6.5}rem` : undefined }}>
            <div className="sticky left-0 z-10 border-b bg-background" />
            {shown.map((d) => (
              <Link
                key={d}
                href={`/schedule?view=day&date=${d}`}
                className={cn("border-b border-l px-2 py-1.5 text-center text-xs font-medium hover:bg-muted", d === today && "bg-sidebar-accent text-primary")}
                title="Open this day"
              >
                {dayLabel(d)}
                <span className="ml-1 font-normal text-muted-foreground">{events.filter((e) => e.day === d).length || ""}</span>
              </Link>
            ))}
            {titanAllDay.some((e) => shown.includes(e.day)) && (
              <>
                <div className="sticky left-0 z-10 border-b bg-background pr-1.5 pt-1 text-right text-[10px] text-muted-foreground">all day</div>
                {shown.map((d) => (
                  <div key={d} className="space-y-0.5 border-b border-l p-0.5">
                    {titanAllDay
                      .filter((e) => e.day === d)
                      .map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => setViewing(e)}
                          className="block w-full truncate rounded px-1 py-0.5 text-left text-[11px] hover:ring-2 hover:ring-primary/40"
                          style={{ background: `${calColor(cal.get(e.calendarUrl)?.color)}26`, borderLeft: `3px solid ${calColor(cal.get(e.calendarUrl)?.color)}` }}
                          title={`${e.title} (Titan: ${cal.get(e.calendarUrl)?.name ?? "calendar"})`}
                        >
                          {e.title}
                        </button>
                      ))}
                  </div>
                ))}
              </>
            )}
            <div className="sticky left-0 z-10 bg-background">
              {Array.from({ length: rows }, (_, i) => (
                <div key={i} style={{ height: ROW }} className="pr-1.5 text-right text-[10px] leading-none text-muted-foreground">
                  {(first + i * SLOT) % 60 === 0 ? clock(first + i * SLOT) : ""}
                </div>
              ))}
            </div>
            {shown.map((d) => {
              const dayJobs = visible.filter((e) => e.day === d);
              const dayTitan = titanTimed.filter((e) => e.day === d);
              const lane = lanes([...dayJobs, ...dayTitan]);
              return (
                <div
                  key={d}
                  role="grid"
                  aria-label={`${dayLabel(d, "long")}: drop a job here to book it`}
                  className={cn("relative border-l", d === today && "bg-sidebar/40")}
                  style={{ height: rows * ROW }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    const at = dropAt(d, e);
                    if (over?.day !== at.day || over.minutes !== at.minutes) setOver(at);
                  }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(null);
                    const job = all.find((j) => j.id === e.dataTransfer.getData("text/job-id"));
                    const at = dropAt(d, e);
                    if (job && (job.day !== at.day || job.minutes !== at.minutes)) save(job, at.day, at.minutes);
                  }}
                >
                  {Array.from({ length: rows }, (_, i) => (
                    <div key={i} style={{ top: i * ROW, height: ROW }} className={cn("absolute inset-x-0 border-t", (first + i * SLOT) % 60 === 0 ? "border-border" : "border-dashed border-border/40")} />
                  ))}
                  {over?.day === d && (
                    <div style={{ top: ((over.minutes - first) / SLOT) * ROW, height: (120 / SLOT) * ROW }} className="pointer-events-none absolute inset-x-1 rounded-md border-2 border-dashed border-primary bg-primary/10 text-[10px] font-medium text-primary">
                      <span className="px-1">{clock(over.minutes)}</span>
                    </div>
                  )}
                  {dayTitan.map((e) => {
                    const l = lane.get(e.id)!;
                    const c = calColor(cal.get(e.calendarUrl)?.color);
                    const height = Math.max(ROW, (Math.min(e.durationMinutes, last - e.minutes) / SLOT) * ROW - 2);
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setViewing(e)}
                        style={{ top: ((e.minutes - first) / SLOT) * ROW + 1, height, left: `calc(${(l.lane / l.of) * 100}% + 2px)`, width: `calc(${100 / l.of}% - 4px)`, background: `${c}1f`, borderColor: `${c}66`, borderLeftColor: c }}
                        className="absolute overflow-hidden rounded-md border border-l-4 border-dashed px-1.5 py-1 text-left text-[11px] leading-tight hover:ring-2 hover:ring-primary/40"
                        aria-label={`${e.title}, ${e.when}. From Titan (${cal.get(e.calendarUrl)?.name ?? "calendar"}).`}
                      >
                        <span className="block font-medium">{clock(e.minutes)}</span>
                        <span className="block truncate">{e.title}</span>
                        {height > 3 * ROW && e.location && <span className="block truncate text-muted-foreground">{e.location}</span>}
                      </button>
                    );
                  })}
                  {dayJobs.map((j) => {
                    const l = lane.get(j.id)!;
                    const height = Math.max(ROW, (j.durationMinutes / SLOT) * ROW - 2);
                    return (
                      <button
                        key={j.id}
                        type="button"
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData("text/job-id", j.id)}
                        onClick={() => open(j)}
                        style={{ top: ((j.minutes! - first) / SLOT) * ROW + 1, height, left: `calc(${(l.lane / l.of) * 100}% + 2px)`, width: `calc(${100 / l.of}% - 4px)` }}
                        className={cn(
                          "absolute cursor-grab overflow-hidden rounded-md border border-l-4 px-1.5 py-1 text-left text-[11px] leading-tight shadow-xs hover:ring-2 hover:ring-primary/40 active:cursor-grabbing",
                          j.assignedTo ? color.get(j.assignedTo) ?? UNASSIGNED : UNASSIGNED,
                        )}
                        aria-label={`${j.jobNumber}, ${j.service}, ${clock(j.minutes!)}. Click to change.`}
                      >
                        <span className="flex items-center gap-1 font-medium">
                          {clock(j.minutes!)}
                          {j.calendarError && <AlertTriangle className="size-3 text-amber-600" aria-label="Not on the Titan calendar yet" />}
                        </span>
                        <span className="block truncate">{j.address ?? j.jobNumber}</span>
                        {height > 3 * ROW && <span className="block truncate text-muted-foreground">{j.service}</span>}
                        {height > 4 * ROW && j.client && <span className="block truncate text-muted-foreground">{j.client}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Drag a job onto the calendar to book it, or drag a booked visit to move it. Click a visit to change its time, length or who&apos;s going. Changes reach the Titan calendar within 5 minutes; clients are never notified.
          {calendars.length > 0 && " Events with dashed borders come from your Titan calendars; change those in Titan."}
        </p>
      </div>

      <aside aria-label="Jobs to schedule" className="rounded-lg border">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">To schedule <span className="font-normal text-muted-foreground">({waiting.length})</span></h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Open jobs with no visit booked. Ready-to-book jobs are first.</p>
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search job, address, client" aria-label="Search jobs to schedule" className="mt-2 h-8" />
        </div>
        <ul className="max-h-[70vh] divide-y overflow-y-auto">
          {filtered.length === 0 && <li className="p-3 text-sm text-muted-foreground">{waiting.length ? "No match." : "Everything open is booked."}</li>}
          {filtered.map((j) => (
            <li key={j.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/job-id", j.id)} className="flex cursor-grab items-start gap-1.5 p-2.5 text-xs hover:bg-muted/60 active:cursor-grabbing">
              <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <Link href={`/jobs/${j.id}`} className="font-mono hover:underline">{j.jobNumber}</Link> · {j.service}
                <span className="block truncate font-medium">{j.address ?? "No property yet"}</span>
                {j.client && <span className="block truncate text-muted-foreground">{j.client}</span>}
                <span className="mt-1 flex flex-wrap gap-1">
                  <Badge variant={j.movesTo ? "default" : "secondary"}>{j.stageName}</Badge>
                  {j.movesTo && <span className="text-[10px] text-muted-foreground">ready to book</span>}
                </span>
              </span>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Book ${j.jobNumber}`} onClick={() => open(j)}>
                <CalendarPlus />
              </Button>
            </li>
          ))}
        </ul>
      </aside>

      {viewing && (
        <Dialog open onOpenChange={(o) => o || setViewing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="size-3 shrink-0 rounded-full" style={{ background: calColor(cal.get(viewing.calendarUrl)?.color) }} aria-hidden />
                {viewing.title}
              </DialogTitle>
              <DialogDescription>{viewing.when}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
              {viewing.location && (
                <>
                  <dt className="text-muted-foreground">Where</dt>
                  <dd>
                    <a className="underline" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(viewing.location)}`} target="_blank" rel="noreferrer">
                      {viewing.location}
                    </a>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Calendar</dt>
              <dd>{cal.get(viewing.calendarUrl)?.name ?? "Titan"}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">This event is on your Titan calendar, not a CRM job. Change or delete it in Titan; the schedule picks up changes when it next loads.</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setViewing(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {editing && (
        <Dialog open onOpenChange={(o) => o || setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editing.job.day ? "Change visit" : "Book visit"} · {editing.job.jobNumber}
              </DialogTitle>
              <DialogDescription>
                {editing.job.service}
                {editing.job.address ? ` at ${editing.job.address}` : ""}
                {editing.job.client ? ` for ${editing.job.client}` : ""}.
                {!editing.job.day && editing.job.movesTo ? ` Booking moves it to ${editing.job.movesTo}.` : ""}
              </DialogDescription>
            </DialogHeader>
            {editing.job.calendarError && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Not on the Titan calendar yet: {editing.job.calendarError}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="sch-day">Day</Label>
                <Input id="sch-day" type="date" value={editing.day} onChange={(e) => setEditing({ ...editing, day: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sch-time">Start</Label>
                <NativeSelect id="sch-time" value={editing.minutes} onChange={(e) => setEditing({ ...editing, minutes: Number(e.target.value) })}>
                  {Array.from({ length: 33 }, (_, i) => 6 * 60 + i * 30).map((m) => <option key={m} value={m}>{clock(m)}</option>)}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sch-len">How long</Label>
                <NativeSelect id="sch-len" value={editing.duration} onChange={(e) => setEditing({ ...editing, duration: Number(e.target.value) })}>
                  {[...new Set([...DURATIONS, editing.duration])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{durationLabel(m)}</option>)}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sch-who">Who&apos;s going</Label>
                <NativeSelect id="sch-who" value={editing.assignedTo} onChange={(e) => setEditing({ ...editing, assignedTo: e.target.value })}>
                  <option value="">Unassigned</option>
                  {staff.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                </NativeSelect>
              </div>
            </div>
            <DialogFooter className="flex-wrap sm:justify-between">
              <span className="flex gap-2">
                <Link href={`/jobs/${editing.job.id}`} className={buttonVariants({ variant: "ghost" })}>Open job</Link>
                {editing.job.day && (
                  <Button type="button" variant="ghost" className="text-destructive" disabled={pending} onClick={() => (save(editing.job, null, null), setEditing(null))}>
                    Take off schedule
                  </Button>
                )}
              </span>
              <span className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  type="button"
                  disabled={pending || !editing.day}
                  onClick={() => {
                    save(editing.job, editing.day, editing.minutes, { durationMinutes: editing.duration, assignedTo: editing.assignedTo || null });
                    setEditing(null);
                  }}
                >
                  {editing.job.day ? "Save" : "Book it"}
                </Button>
              </span>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
