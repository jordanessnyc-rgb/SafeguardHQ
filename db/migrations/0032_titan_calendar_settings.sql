ALTER TABLE "settings" ADD COLUMN "calendar_write_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "calendar_hidden_urls" text[] DEFAULT '{}'::text[] NOT NULL;