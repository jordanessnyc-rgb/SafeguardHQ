ALTER TABLE "activities" DROP COLUMN "sensitive";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "sensitive_enc";--> statement-breakpoint
ALTER TABLE "airnyc_cases" DROP COLUMN "member_name_enc";--> statement-breakpoint
ALTER TABLE "airnyc_cases" DROP COLUMN "guardian_name_enc";--> statement-breakpoint
ALTER TABLE "airnyc_cases" DROP COLUMN "member_phone_enc";--> statement-breakpoint
ALTER TABLE "airnyc_cases" DROP COLUMN "address_enc";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "airnyc_ai_allowed";