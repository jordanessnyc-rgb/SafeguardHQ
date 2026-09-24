-- Hand-added: the jobs.job_number column default calls this, so it must exist before CREATE TABLE.
-- (plpgsql bodies are not validated at creation, so job_number_counters can be created below.)
CREATE OR REPLACE FUNCTION public.next_job_number() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  y integer := extract(year from (now() at time zone 'America/New_York'))::integer;
  n integer;
BEGIN
  INSERT INTO public.job_number_counters AS c (year, last_value) VALUES (y, 1)
  ON CONFLICT (year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING c.last_value INTO n;
  RETURN format('ESS-%s-%s', y, lpad(n::text, 4, '0'));
END $$;--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('CALL', 'SMS', 'EMAIL_IN', 'EMAIL_OUT', 'NOTE', 'STAGE_CHANGE', 'DOC', 'PAYMENT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."airnyc_mode" AS ENUM('MANUAL', 'EMAIL', 'POWER_AUTOMATE', 'GRAPH');--> statement-breakpoint
CREATE TYPE "public"."brand" AS ENUM('ESS', 'GAS_PRO');--> statement-breakpoint
CREATE TYPE "public"."campaign_channel" AS ENUM('DIRECT_MAIL', 'EMAIL', 'WEB', 'DOOR_TO_DOOR');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('NOT_REQUESTED', 'REQUESTED', 'RECEIVED', 'DECLINED', 'NOT_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('WEB_FORM', 'QUO', 'EMAIL', 'MAILER_CAMPAIGN', 'REFERRAL', 'BID', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('INBOUND', 'OUTBOUND', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('PROPOSAL', 'REPORT', 'WORK_PLAN', 'SUB_COPY', 'CLEARANCE', 'INVOICE_PDF', 'CONSENT', 'LAB_RESULT', 'PHOTO_LOG', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('DRAFT', 'QA', 'FINAL', 'SENT', 'SIGNED');--> statement-breakpoint
CREATE TYPE "public"."enrichment_status" AS ENUM('PENDING', 'OK', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('OWNER', 'MANAGEMENT_CO', 'REFERRAL_PARTNER', 'GOV_AGENCY', 'SUBCONTRACTOR', 'LAB', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."preferred_channel" AS ENUM('PHONE', 'SMS', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."property_role" AS ENUM('OWNER', 'MANAGER', 'TENANT', 'SUPER', 'BROKER');--> statement-breakpoint
CREATE TYPE "public"."qc_status" AS ENUM('NOT_SUBMITTED', 'SUBMITTED', 'REVISIONS_REQUESTED', 'APPROVED');--> statement-breakpoint
CREATE TYPE "public"."sample_status" AS ENUM('COLLECTED', 'SUBMITTED', 'RESULTS_IN', 'REVIEWED');--> statement-breakpoint
CREATE TYPE "public"."sample_type" AS ENUM('AIR', 'SWAB', 'TAPE', 'BULK', 'DUST_WIPE', 'WATER');--> statement-breakpoint
CREATE TYPE "public"."service_code" AS ENUM('MOLD_ASSESS', 'MOLD_PLAN', 'MOLD_CLEAR', 'LEAD_RA', 'LEAD_CLEAR', 'LEAD_WATER', 'ASB_SURVEY', 'LL152', 'LL126', 'LL31', 'VIOLATION', 'AIRNYC', 'BID');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('MANUAL', 'QUO_NEXT_STEP', 'EMAIL_AI', 'SYSTEM_RULE');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'VA', 'FIELD', 'SUB');--> statement-breakpoint
CREATE TYPE "public"."violation_source" AS ENUM('HPD', 'DOB', 'ECB');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"type" "activity_type" NOT NULL,
	"direction" "direction",
	"contact_id" uuid,
	"property_id" uuid,
	"job_id" uuid,
	"airnyc_case_id" uuid,
	"bid_id" uuid,
	"brand" "brand",
	"channel_line" text,
	"subject" text,
	"body" text,
	"summary" text,
	"next_steps" text[],
	"external_id" text,
	"external_url" text,
	"raw" jsonb,
	"ai_classification" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "airnyc_case_checklist" (
	"case_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_by" uuid,
	CONSTRAINT "airnyc_case_checklist_case_id_item_id_pk" PRIMARY KEY("case_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "airnyc_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"case_id" text NOT NULL,
	"network" text,
	"member_name_enc" text,
	"guardian_name_enc" text,
	"member_phone_enc" text,
	"address_enc" text,
	"property_id" uuid,
	"case_manager_name" text,
	"case_manager_email" text,
	"approved_services" text[] DEFAULT '{}'::text[] NOT NULL,
	"tracker_row" integer,
	"landlord_consent_status" "consent_status" DEFAULT 'NOT_REQUESTED' NOT NULL,
	"tenant_consent_status" "consent_status" DEFAULT 'NOT_REQUESTED' NOT NULL,
	"is_nycha" boolean DEFAULT false NOT NULL,
	"qc_reviewer" text,
	"qc_status" "qc_status" DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"sharepoint_folder_url" text,
	"pipeline_key" text DEFAULT 'AIRNYC' NOT NULL,
	"stage" text DEFAULT 'REFERRAL_RECEIVED' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" uuid,
	"scope_not_covered" boolean DEFAULT false NOT NULL,
	"out_of_scope_observations" text,
	"drive_folder_url" text,
	"drive_folder_id" text
);
--> statement-breakpoint
CREATE TABLE "airnyc_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" text NOT NULL,
	"label" text NOT NULL,
	"file_name_pattern" text,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "campaign_costs" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"cost" numeric(12, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"name" text NOT NULL,
	"brand" "brand" DEFAULT 'ESS' NOT NULL,
	"channel" "campaign_channel" NOT NULL,
	"sent_count" integer,
	"tracking" jsonb,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"first_name" text,
	"last_name" text,
	"org_id" uuid,
	"title" text,
	"emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"quo_contact_id" text,
	"preferred_channel" "preferred_channel",
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"source" "contact_source" DEFAULT 'MANUAL' NOT NULL,
	"campaign_id" uuid,
	"brand" "brand" DEFAULT 'ESS' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"job_id" uuid,
	"airnyc_case_id" uuid,
	"kind" "document_kind" NOT NULL,
	"title" text,
	"version" integer DEFAULT 1 NOT NULL,
	"storage_bucket" text,
	"storage_path" text,
	"drive_file_id" text,
	"status" "document_status" DEFAULT 'DRAFT' NOT NULL,
	"contains_pricing" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"job_id" uuid NOT NULL,
	"readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observations" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"areas" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "field_data_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "invoices_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"freshbooks_invoice_id" text NOT NULL,
	"job_id" uuid,
	"org_id" uuid,
	"status" text,
	"amount" numeric(12, 2),
	"outstanding" numeric(12, 2),
	"issued_at" date,
	"due_at" date,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_cache_freshbooks_invoice_id_unique" UNIQUE("freshbooks_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "job_financials" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"quoted_amount" numeric(12, 2),
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sub_cost" numeric(12, 2),
	"lab_cost" numeric(12, 2),
	"other_cost" numeric(12, 2),
	"freshbooks_estimate_id" text,
	"freshbooks_invoice_id" text,
	"invoice_status" text,
	"amount_paid" numeric(12, 2),
	"paid_at" timestamp with time zone,
	"hold_report_until_paid" boolean,
	"gross_margin" numeric(12, 2) GENERATED ALWAYS AS (coalesce(quoted_amount, 0) - coalesce(sub_cost, 0) - coalesce(lab_cost, 0) - coalesce(other_cost, 0)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_number_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"job_number" text DEFAULT public.next_job_number() NOT NULL,
	"brand" "brand" DEFAULT 'ESS' NOT NULL,
	"service_code" "service_code" NOT NULL,
	"pipeline_key" text NOT NULL,
	"stage" text NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lost_reason" text,
	"priority" "priority" DEFAULT 'NORMAL' NOT NULL,
	"source" "contact_source",
	"title" text,
	"property_id" uuid,
	"client_org_id" uuid,
	"client_contact_id" uuid,
	"scheduled_at" timestamp with time zone,
	"field_completed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"drive_folder_url" text,
	"drive_folder_id" text,
	"assigned_to" uuid,
	"sub_org_id" uuid,
	"hpd_violation_ref" text,
	"airnyc_case_id" uuid,
	"next_cycle_due" date,
	"notes" text,
	CONSTRAINT "jobs_job_number_unique" UNIQUE("job_number")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"name" text NOT NULL,
	"type" "org_type" DEFAULT 'OTHER' NOT NULL,
	"brand" "brand" DEFAULT 'ESS' NOT NULL,
	"freshbooks_client_id" text,
	"website" text,
	"phone" text,
	"email" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"pipeline_key" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"stale_after_days" integer,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_pipeline_key_key_pk" PRIMARY KEY("pipeline_key","key")
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"service_codes" "service_code"[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"role" "user_role",
	"org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"bbl" text,
	"bin" text,
	"address_line" text NOT NULL,
	"unit" text,
	"borough" text,
	"zip" text,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"building_class" text,
	"units_res" integer,
	"year_built" integer,
	"owner_name" text,
	"hpd_registration_id" text,
	"hpd_registration_contacts" jsonb,
	"management_org_id" uuid,
	"is_nycha" boolean DEFAULT false NOT NULL,
	"notes" text,
	"geosearch_raw" jsonb,
	"enrichment_status" "enrichment_status" DEFAULT 'PENDING' NOT NULL,
	"enriched_at" timestamp with time zone,
	"enrichment_error" text
);
--> statement-breakpoint
CREATE TABLE "property_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"property_id" uuid NOT NULL,
	"contact_id" uuid,
	"org_id" uuid,
	"role" "property_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"source" "violation_source" NOT NULL,
	"violation_id" text NOT NULL,
	"class" text,
	"order_number" text,
	"status" text,
	"is_open" boolean DEFAULT true NOT NULL,
	"issued_date" date,
	"description" text,
	"raw" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"job_id" uuid NOT NULL,
	"sample_id" text NOT NULL,
	"type" "sample_type" NOT NULL,
	"location" text,
	"lab_org_id" uuid,
	"coc_number" text,
	"submitted_at" timestamp with time zone,
	"results_received_at" timestamp with time zone,
	"result_pdf_path" text,
	"results" jsonb,
	"status" "sample_status" DEFAULT 'COLLECTED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"auto_send_email" boolean DEFAULT false NOT NULL,
	"auto_send_sms" boolean DEFAULT false NOT NULL,
	"auto_create_invoice" boolean DEFAULT false NOT NULL,
	"hold_report_until_paid_default" boolean DEFAULT false NOT NULL,
	"airnyc_ai_allowed" boolean DEFAULT false NOT NULL,
	"airnyc_mode" "airnyc_mode" DEFAULT 'MANUAL' NOT NULL,
	"digest_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"digest_time" time DEFAULT '07:30' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"business_hours" jsonb NOT NULL,
	"drive_jobs_parent_folder_id" text,
	"drive_airnyc_parent_folder_id" text,
	"drive_template_folder_id" text,
	"ai_monthly_cost_cap_usd" numeric(10, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sub_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"sub_org_id" uuid,
	"is_rate_card" boolean DEFAULT false NOT NULL,
	"description" text,
	"amount" numeric(12, 2),
	"rates" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"title" text NOT NULL,
	"description" text,
	"due_at" timestamp with time zone,
	"assignee" uuid,
	"status" "task_status" DEFAULT 'OPEN' NOT NULL,
	"source" "task_source" DEFAULT 'MANUAL' NOT NULL,
	"job_id" uuid,
	"airnyc_case_id" uuid,
	"bid_id" uuid,
	"contact_id" uuid,
	"property_id" uuid,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_airnyc_case_id_airnyc_cases_id_fk" FOREIGN KEY ("airnyc_case_id") REFERENCES "public"."airnyc_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airnyc_case_checklist" ADD CONSTRAINT "airnyc_case_checklist_case_id_airnyc_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."airnyc_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airnyc_case_checklist" ADD CONSTRAINT "airnyc_case_checklist_item_id_airnyc_checklist_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."airnyc_checklist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airnyc_cases" ADD CONSTRAINT "airnyc_cases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airnyc_cases" ADD CONSTRAINT "airnyc_cases_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airnyc_cases" ADD CONSTRAINT "airnyc_cases_pipeline_stage_fk" FOREIGN KEY ("pipeline_key","stage") REFERENCES "public"."pipeline_stages"("pipeline_key","key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "campaign_costs" ADD CONSTRAINT "campaign_costs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_data" ADD CONSTRAINT "field_data_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD CONSTRAINT "invoices_cache_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD CONSTRAINT "invoices_cache_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_financials" ADD CONSTRAINT "job_financials_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_org_id_organizations_id_fk" FOREIGN KEY ("client_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_contact_id_contacts_id_fk" FOREIGN KEY ("client_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_to_profiles_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sub_org_id_organizations_id_fk" FOREIGN KEY ("sub_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pipeline_stage_fk" FOREIGN KEY ("pipeline_key","stage") REFERENCES "public"."pipeline_stages"("pipeline_key","key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_key_pipelines_key_fk" FOREIGN KEY ("pipeline_key") REFERENCES "public"."pipelines"("key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_management_org_id_organizations_id_fk" FOREIGN KEY ("management_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_roles" ADD CONSTRAINT "property_roles_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_roles" ADD CONSTRAINT "property_roles_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_roles" ADD CONSTRAINT "property_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_violations" ADD CONSTRAINT "property_violations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_lab_org_id_organizations_id_fk" FOREIGN KEY ("lab_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_costs" ADD CONSTRAINT "sub_costs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_costs" ADD CONSTRAINT "sub_costs_sub_org_id_organizations_id_fk" FOREIGN KEY ("sub_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_profiles_user_id_fk" FOREIGN KEY ("assignee") REFERENCES "public"."profiles"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_airnyc_case_id_airnyc_cases_id_fk" FOREIGN KEY ("airnyc_case_id") REFERENCES "public"."airnyc_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_job_idx" ON "activities" USING btree ("job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_contact_idx" ON "activities" USING btree ("contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_property_idx" ON "activities" USING btree ("property_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activities_external_uq" ON "activities" USING btree ("type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "airnyc_cases_case_id_uq" ON "airnyc_cases" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contacts_phones_gin" ON "contacts" USING gin ("phones");--> statement-breakpoint
CREATE INDEX "contacts_emails_gin" ON "contacts" USING gin ("emails");--> statement-breakpoint
CREATE INDEX "documents_job_idx" ON "documents" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_stage_idx" ON "jobs" USING btree ("pipeline_key","stage");--> statement-breakpoint
CREATE INDEX "jobs_property_idx" ON "jobs" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "organizations_name_idx" ON "organizations" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_bbl_unit_uq" ON "properties" USING btree ("bbl",coalesce("unit", '')) WHERE "properties"."bbl" is not null and "properties"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "properties_bin_idx" ON "properties" USING btree ("bin");--> statement-breakpoint
CREATE INDEX "properties_address_idx" ON "properties" USING btree ("address_line");--> statement-breakpoint
CREATE INDEX "property_roles_property_idx" ON "property_roles" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_violations_uq" ON "property_violations" USING btree ("property_id","source","violation_id");--> statement-breakpoint
CREATE INDEX "property_violations_open_idx" ON "property_violations" USING btree ("property_id","is_open");--> statement-breakpoint
CREATE INDEX "samples_job_idx" ON "samples" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "samples_coc_idx" ON "samples" USING btree ("coc_number");--> statement-breakpoint
CREATE UNIQUE INDEX "samples_job_sample_uq" ON "samples" USING btree ("job_id","sample_id");--> statement-breakpoint
CREATE INDEX "tasks_open_idx" ON "tasks" USING btree ("status","due_at");