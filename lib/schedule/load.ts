/**
 * Data for the schedule calendar (Phase 7c). Times are sent to the browser as New York wall-clock
 * ("2026-10-01", minutes after midnight) so the grid is right whatever time zone the phone is in.
 */
import { and, asc, eq, gte, isNotNull, isNull, lt, ne, notInArray } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";
import { label, personName, SERVICE_LABELS } from "@/lib/labels";
import { loadPipelines } from "@/lib/pipeline/config";
import { EVENT_MINUTES } from "@/lib/calendar/sync";
import { fromNyInput, nyDate, toNyInput } from "@/lib/time";
import { stageAfterScheduling } from "./rules";

export type ScheduleJob = {
  id: string;
  jobNumber: string;
  service: string;
  address: string | null;
  borough: string | null;
  client: string | null;
  stage: string;
  stageName: string;
  assignedTo: string | null;
  durationMinutes: number;
  /** Set for scheduled jobs: New York date and minutes after midnight. */
  day: string | null;
  minutes: number | null;
  calendarError: string | null;
  /** For unscheduled jobs: scheduling it moves it to this stage. */
  movesTo: string | null;
};

/** The 7 New York dates of the Monday-start week containing `day`, or just `day`. */
export function scheduleDays(day: string, view: "week" | "day"): string[] {
  if (view === "day") return [day];
  const d = new Date(`${day}T12:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

export const shiftDay = (day: string, days: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export async function loadSchedule(tx: Tx, days: string[]) {
  const pipelines = await loadPipelines(tx);
  const stageInfo = new Map(pipelines.flatMap((p) => p.stages.map((st) => [`${p.key}:${st.key}`, st] as const)));
  const terminal = [...new Set(pipelines.flatMap((p) => p.stages.filter((st) => st.isTerminal).map((st) => st.key)))];
  const from = fromNyInput(`${days[0]}T00:00`);
  const to = fromNyInput(`${shiftDay(days[days.length - 1], 1)}T00:00`);

  const base = () =>
    tx
      .select({ job: s.jobs, address: s.properties.addressLine, unit: s.properties.unit, borough: s.properties.borough, org: s.organizations.name, contact: { firstName: s.contacts.firstName, lastName: s.contacts.lastName } })
      .from(s.jobs)
      .leftJoin(s.properties, eq(s.properties.id, s.jobs.propertyId))
      .leftJoin(s.organizations, eq(s.organizations.id, s.jobs.clientOrgId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.clientContactId));
  type Row = Awaited<ReturnType<ReturnType<typeof base>["where"]>>[number];
  const shape = ({ job, address, unit, borough, org, contact }: Row): ScheduleJob => {
    const local = job.scheduledAt ? toNyInput(job.scheduledAt) : null;
    const stages = pipelines.find((p) => p.key === job.pipelineKey)?.stages ?? [];
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      service: label(SERVICE_LABELS, job.serviceCode),
      address: address ? `${address}${unit ? ` #${unit}` : ""}` : null,
      borough,
      // AIRnyc member details never leave the case page.
      client: job.airnycCaseId ? "AIRnyc case" : (org ?? (contact?.firstName || contact?.lastName ? personName(contact!) : null)),
      stage: job.stage,
      stageName: stageInfo.get(`${job.pipelineKey}:${job.stage}`)?.name ?? job.stage,
      assignedTo: job.assignedTo,
      durationMinutes: job.durationMinutes ?? EVENT_MINUTES,
      day: local ? local.slice(0, 10) : null,
      minutes: local ? Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) : null,
      calendarError: job.calendarError,
      movesTo: job.scheduledAt ? null : (() => {
        const k = stageAfterScheduling(stages, job.stage);
        return k ? (stageInfo.get(`${job.pipelineKey}:${k}`)?.name ?? k) : null;
      })(),
    };
  };

  const scheduled = (await base().where(and(isNull(s.jobs.archivedAt), ne(s.jobs.stage, "LOST"), isNotNull(s.jobs.scheduledAt), gte(s.jobs.scheduledAt, from), lt(s.jobs.scheduledAt, to))).orderBy(asc(s.jobs.scheduledAt))).map(shape);
  const unscheduled = (
    await base()
      .where(and(isNull(s.jobs.archivedAt), isNull(s.jobs.scheduledAt), terminal.length ? notInArray(s.jobs.stage, terminal) : undefined))
      .orderBy(asc(s.jobs.createdAt))
      .limit(300)
  ).map(shape);
  // Ready-to-book first (the next stage is "Scheduled"), then the rest oldest first.
  unscheduled.sort((a, b) => Number(Boolean(b.movesTo)) - Number(Boolean(a.movesTo)));

  const staff = (await tx.select({ id: s.profiles.userId, fullName: s.profiles.fullName, email: s.profiles.email }).from(s.profiles).where(isNotNull(s.profiles.role)).orderBy(asc(s.profiles.fullName))).map((u) => ({
    id: u.id,
    label: u.fullName ?? u.email,
  }));
  return { scheduled, unscheduled, staff, today: nyDate(new Date()) };
}
