ALTER TYPE "public"."task_source" ADD VALUE 'CALL_AI';--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "ai_extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ai_voice_notes" text;