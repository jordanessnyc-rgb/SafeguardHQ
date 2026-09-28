/** Stages that mean "a visit is on the calendar", per pipeline (INSPECTION, AIRNYC, WORK_PLAN). */
export const SCHEDULED_STAGES = new Set(["SCHEDULED", "ASSESSMENT_SCHEDULED", "SITE_VISIT"]);

/**
 * When a job gets a visit date and the very next stage in its pipeline is a "scheduled" stage, it moves
 * there (Signed → Scheduled, Consent → Assessment scheduled). Earlier stages (a lead, a proposal out)
 * keep their stage: a site visit before the proposal is signed is still just a visit.
 */
export function stageAfterScheduling(stages: { key: string; position: number; isTerminal: boolean }[], current: string): string | null {
  const open = stages.filter((st) => !st.isTerminal).sort((a, b) => a.position - b.position);
  const i = open.findIndex((st) => st.key === current);
  const next = i >= 0 ? open[i + 1] : undefined;
  return next && SCHEDULED_STAGES.has(next.key) ? next.key : null;
}

export const DURATIONS = [30, 60, 90, 120, 180, 240, 360, 480] as const;
export const durationLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m === 480 ? "Full day (8h)" : `${m / 60}h`);
