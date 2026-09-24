CREATE TYPE "public"."client_match_status" AS ENUM('PENDING', 'LINKED', 'CREATED', 'IGNORED');--> statement-breakpoint
CREATE TABLE "digest_runs" (
	"run_date" date PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipients" text[],
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "freshbooks_clients" (
	"freshbooks_client_id" text PRIMARY KEY NOT NULL,
	"organization" text,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"match_status" "client_match_status" DEFAULT 'PENDING' NOT NULL,
	"suggested_org_id" uuid,
	"suggested_contact_id" uuid,
	"match_reason" text,
	"linked_org_id" uuid,
	"linked_contact_id" uuid,
	"raw" jsonb,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freshbooks_connection" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"account_id" text NOT NULL,
	"business_id" text,
	"business_name" text,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text,
	"connected_by" uuid,
	"last_refresh_at" timestamp with time zone,
	"last_error" text,
	"webhook_callbacks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments_cache" (
	"freshbooks_payment_id" text PRIMARY KEY NOT NULL,
	"freshbooks_invoice_id" text,
	"job_id" uuid,
	"amount" numeric(12, 2),
	"paid_on" date,
	"type" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "freshbooks_client_id" text;--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD COLUMN "freshbooks_client_id" text;--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD COLUMN "paid" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "invoices_cache" ADD COLUMN "fb_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_financials" ADD COLUMN "report_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_financials" ADD COLUMN "invoice_error" text;--> statement-breakpoint
ALTER TABLE "job_financials" ADD COLUMN "invoice_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "digest_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "digest_sms_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "invoice_payment_terms_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "freshbooks_clients" ADD CONSTRAINT "freshbooks_clients_suggested_org_id_organizations_id_fk" FOREIGN KEY ("suggested_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freshbooks_clients" ADD CONSTRAINT "freshbooks_clients_suggested_contact_id_contacts_id_fk" FOREIGN KEY ("suggested_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freshbooks_clients" ADD CONSTRAINT "freshbooks_clients_linked_org_id_organizations_id_fk" FOREIGN KEY ("linked_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freshbooks_clients" ADD CONSTRAINT "freshbooks_clients_linked_contact_id_contacts_id_fk" FOREIGN KEY ("linked_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments_cache" ADD CONSTRAINT "payments_cache_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;