CREATE TABLE "worker_status" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"interval_seconds" integer
);
