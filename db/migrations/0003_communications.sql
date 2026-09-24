CREATE TYPE "public"."outbound_channel" AS ENUM('SMS', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."outbound_source" AS ENUM('MANUAL', 'TEMPLATE', 'MISSED_CALL', 'AI_DRAFT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('DRAFT', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."triage_status" AS ENUM('PENDING', 'AUTO', 'NEEDS_REVIEW', 'REVIEWED', 'BLOCKED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 5),
	"job_id" uuid,
	"activity_id" uuid,
	"airnyc_linked" boolean DEFAULT false NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"blocked" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "mail_sync_state" (
	"mailbox" text NOT NULL,
	"folder" text NOT NULL,
	"uid_validity" text,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"last_connected_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"last_alert_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sync_state_mailbox_folder_pk" PRIMARY KEY("mailbox","folder")
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"channel" "outbound_channel" NOT NULL,
	"brand" "brand",
	"subject" text,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "message_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"channel" "outbound_channel" NOT NULL,
	"status" "outbound_status" DEFAULT 'DRAFT' NOT NULL,
	"source" "outbound_source" DEFAULT 'MANUAL' NOT NULL,
	"template_key" text,
	"to_address" text NOT NULL,
	"from_line_id" uuid,
	"from_email" text,
	"subject" text,
	"body" text NOT NULL,
	"in_reply_to" text,
	"brand" "brand" DEFAULT 'ESS' NOT NULL,
	"contact_id" uuid,
	"job_id" uuid,
	"airnyc_case_id" uuid,
	"reply_to_activity_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"external_id" text,
	"error" text,
	"contains_pricing" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"quo_phone_number_id" text NOT NULL,
	"number" text NOT NULL,
	"label" text NOT NULL,
	"line_key" text NOT NULL,
	"brand" "brand" DEFAULT 'ESS' NOT NULL,
	"missed_call_textback" boolean DEFAULT false NOT NULL,
	CONSTRAINT "phone_lines_quo_phone_number_id_unique" UNIQUE("quo_phone_number_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "from_address" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "to_address" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "thread_key" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "call_status" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "triage_status" "triage_status";--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "triage_category" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sensitive_enc" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "quo_summaries_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "health_alert_phone" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "health_alert_line_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_from_email" text DEFAULT 'sales@ess-nyc.com' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "airnyc_sender_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "triage_confidence_threshold" numeric(3, 2) DEFAULT '0.75' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_from_line_id_phone_lines_id_fk" FOREIGN KEY ("from_line_id") REFERENCES "public"."phone_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_airnyc_case_id_airnyc_cases_id_fk" FOREIGN KEY ("airnyc_case_id") REFERENCES "public"."airnyc_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_at_idx" ON "ai_calls" USING btree ("at");--> statement-breakpoint
CREATE INDEX "outbound_status_idx" ON "outbound_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_uq" ON "webhook_deliveries" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE INDEX "activities_thread_idx" ON "activities" USING btree ("thread_key");--> statement-breakpoint
CREATE INDEX "activities_triage_idx" ON "activities" USING btree ("triage_status");