ALTER TABLE "documents" ADD COLUMN "docusign_envelope_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "docusign_status" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "signed_document_id" uuid;