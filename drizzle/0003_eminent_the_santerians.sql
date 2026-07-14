ALTER TABLE "collection_runs" ADD COLUMN IF NOT EXISTS "summary_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN IF NOT EXISTS "summary_attempted_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN IF NOT EXISTS "summary_succeeded_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN IF NOT EXISTS "summary_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN IF NOT EXISTS "summary_error_code" text;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN IF NOT EXISTS "summary_error_message" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "ai_summary" text;
