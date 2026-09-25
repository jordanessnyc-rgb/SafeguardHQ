import { and, eq, inArray, or, sql } from "drizzle-orm";
import { schema as s } from "@/lib/db";

/**
 * Messages waiting in Inbox review (SPEC §9.1): low-confidence triage, AI-blocked (AIRnyc) items, and
 * anything still untriaged after 10 minutes. Shared by the review page, the nav badge and the dashboard.
 */
export const inboxReviewWhere = or(
  inArray(s.activities.triageStatus, ["NEEDS_REVIEW", "BLOCKED"]),
  and(eq(s.activities.triageStatus, "PENDING"), sql`${s.activities.createdAt} < now() - interval '10 minutes'`),
);

/** Outbox drafts that still need a person: not yet approved, or a send that failed. */
export const OUTBOX_WAITING = ["DRAFT", "FAILED"] as const;

type JobRef = { id: string; jobNumber: string; address: string | null };

/**
 * The job an AI triage's `job_match_hints` most likely point to: an exact job number first, else an
 * open job whose address contains (or is contained in) a hint that has a house number in it — so a bare
 * neighbourhood like "Astoria" never picks a job. Hints under 4 characters are ignored.
 */
export function suggestJob<J extends JobRef>(hints: string[] | undefined, jobs: J[]): J | undefined {
  const hs = (hints ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h.length >= 4);
  if (!hs.length) return undefined;
  return (
    jobs.find((j) => hs.includes(j.jobNumber.toLowerCase())) ??
    jobs.find((j) => {
      const addr = j.address?.toLowerCase();
      return Boolean(addr) && hs.some((h) => /\d/.test(h) && (addr!.includes(h) || h.includes(addr!)));
    })
  );
}
