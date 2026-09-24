/**
 * Pipeline stage rules (SPEC §5). The database trigger `enforce_job_stage_rules` is the authority;
 * this mirrors it so the UI can explain a blocked move before the round trip. Keep them in sync —
 * tests/db/pipeline.test.ts checks both against the same scenarios.
 */

export type StageFacts = {
  fromStage: string | null;
  fromStageIsTerminal: boolean;
  toStage: string;
  lostReason?: string | null;
  submittedSampleCount: number;
  finalReportCount: number;
};

export const STAGE_RULE_PREFIX = "STAGE_RULE:";

export function checkStageTransition(f: StageFacts): string[] {
  const errors: string[] = [];
  if (f.fromStage === f.toStage) return errors;

  if (f.toStage === "LOST") {
    if (!f.lostReason?.trim()) errors.push("A lost reason is required to mark a job Lost.");
    if (f.fromStage !== null && f.fromStageIsTerminal) errors.push("Lost can only be entered from an open stage.");
  }
  if (f.toStage === "LAB_PENDING" && f.submittedSampleCount < 1) {
    errors.push("Lab Pending requires at least one sample in SUBMITTED status.");
  }
  if (f.toStage === "DELIVERED" && f.finalReportCount < 1) {
    errors.push("Delivered requires a FINAL report document.");
  }
  return errors;
}

/** Extracts the human message from a Postgres error raised by the stage trigger, if it is one. */
export function stageRuleMessage(err: unknown): string | null {
  const e = err as { message?: string; cause?: { message?: string } };
  const msg = e?.cause?.message ?? e?.message ?? "";
  const i = msg.indexOf(STAGE_RULE_PREFIX);
  return i >= 0 ? msg.slice(i + STAGE_RULE_PREFIX.length).trim() : null;
}

/** Days a job has sat in its current stage, for the stale badge and digest. */
export function daysInStage(stageEnteredAt: Date, now = new Date()): number {
  return Math.floor((now.getTime() - stageEnteredAt.getTime()) / 86_400_000);
}

export function isStale(stageEnteredAt: Date, staleAfterDays: number | null, now = new Date()): boolean {
  return staleAfterDays != null && daysInStage(stageEnteredAt, now) > staleAfterDays;
}
