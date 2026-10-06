ALTER TABLE "airnyc_cases" ADD COLUMN "sharepoint_drive_id" text;--> statement-breakpoint
ALTER TABLE "airnyc_cases" ADD COLUMN "sharepoint_item_id" text;--> statement-breakpoint
ALTER TABLE "airnyc_cases" ADD COLUMN "tracker_status" text;--> statement-breakpoint
ALTER TABLE "airnyc_cases" ADD COLUMN "tracker_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_tracker_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_tracker_sheet" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_tracker_columns" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_root_folder_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_graph_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_graph_error" text;