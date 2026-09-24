CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"service_code" "service_code" NOT NULL,
	"base_amount" numeric(12, 2) NOT NULL,
	"included_sqft" integer DEFAULT 0 NOT NULL,
	"per_sqft" numeric(12, 4),
	"included_samples" integer DEFAULT 0 NOT NULL,
	"per_sample" numeric(12, 2),
	"minimum_amount" numeric(12, 2),
	"default_scope" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pricing_rules_service_code_unique" UNIQUE("service_code")
);
--> statement-breakpoint
ALTER TABLE "job_financials" ADD COLUMN "quote_inputs" jsonb;--> statement-breakpoint
ALTER TABLE "sub_costs" ADD COLUMN "selected" boolean DEFAULT false NOT NULL;