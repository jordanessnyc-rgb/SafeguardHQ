CREATE TYPE "public"."bid_role" AS ENUM('PRIME', 'SUB');--> statement-breakpoint
CREATE TYPE "public"."bid_source" AS ENUM('MANUAL', 'NYSCR', 'CITY_RECORD', 'PASSPORT', 'COUNTY', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."bid_status" AS ENUM('WATCHING', 'GO_NO_GO', 'DRAFTING', 'SUBMITTED', 'AWARDED', 'LOST', 'NO_BID');--> statement-breakpoint
CREATE TYPE "public"."bid_type" AS ENUM('RFP', 'RFQ', 'RFB', 'IFB', 'OTHER');--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT auth.uid(),
	"archived_at" timestamp with time zone,
	"agency" text,
	"solicitation_number" text,
	"title" text NOT NULL,
	"type" "bid_type" DEFAULT 'OTHER' NOT NULL,
	"prime_entity" text DEFAULT 'ESS' NOT NULL,
	"role" "bid_role" DEFAULT 'PRIME' NOT NULL,
	"questions_due" timestamp with time zone,
	"due_at" timestamp with time zone,
	"opening_at" timestamp with time zone,
	"site_visit_at" timestamp with time zone,
	"buyer_name" text,
	"buyer_email" text,
	"buyer_phone" text,
	"required_certs" text[] DEFAULT '{}'::text[] NOT NULL,
	"cert_gaps" text[] DEFAULT '{}'::text[] NOT NULL,
	"insurance_requirements" text,
	"scope" text,
	"status" "bid_status" DEFAULT 'WATCHING' NOT NULL,
	"source" "bid_source" DEFAULT 'MANUAL' NOT NULL,
	"source_url" text,
	"external_id" text,
	"go_no_go" jsonb,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "bid_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "bids_source_external_uq" ON "bids" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "bids_due_idx" ON "bids" USING btree ("due_at");