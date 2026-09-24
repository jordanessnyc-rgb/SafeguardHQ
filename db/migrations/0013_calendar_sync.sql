ALTER TABLE "jobs" ADD COLUMN "calendar_hash" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "calendar_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "calendar_error" text;