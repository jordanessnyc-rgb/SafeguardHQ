-- 0040 — Workflows never send on their own (requested 2026-11-25): drop the per-workflow auto-send switch.
-- Every workflow email/text is an Outbox draft a person approves (CLAUDE.md rule 6).
ALTER TABLE "workflows" DROP COLUMN "auto_send";
