ALTER TABLE "freshbooks_connection" ADD COLUMN "history_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "freshbooks_connection" ADD COLUMN "history_status" jsonb;