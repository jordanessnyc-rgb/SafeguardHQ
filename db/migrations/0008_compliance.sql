CREATE TYPE "public"."expiry_subject" AS ENUM('CREDENTIAL', 'SUB_COI');--> statement-breakpoint
CREATE TABLE "compliance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"service_code" "service_code" NOT NULL,
	"cycle_months" integer,
	"lead_time_days" integer DEFAULT 60 NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "compliance_rules_service_code_unique" UNIQUE("service_code")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"name" text NOT NULL,
	"number" text,
	"issuer" text,
	"expires_at" date,
	"file_path" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "expiry_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "expiry_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"expires_on" date NOT NULL,
	"threshold_days" integer NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expiry_alerts_once" UNIQUE("subject_type","subject_id","expires_on","threshold_days")
);
--> statement-breakpoint
CREATE TABLE "sub_profiles" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"trades" text[] DEFAULT '{}'::text[] NOT NULL,
	"license_numbers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"insurance_expires" date,
	"coi_path" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cycle_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expiry_alerts" ADD CONSTRAINT "expiry_alerts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_profiles" ADD CONSTRAINT "sub_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;