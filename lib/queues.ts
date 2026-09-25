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
