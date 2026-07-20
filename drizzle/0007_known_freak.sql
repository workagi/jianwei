ALTER TABLE "items" ADD COLUMN "analysis_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_provider" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_model" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_version" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_error_code" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analysis_error_message" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "items_analysis_status_idx" ON "items" USING btree ("analysis_status");--> statement-breakpoint
UPDATE "items"
SET
  "analysis_status" = CASE
    WHEN nullif(btrim("ai_summary"), '') IS NULL THEN 'pending'
    WHEN nullif(btrim("content_type"), '') IS NOT NULL AND jsonb_array_length("topic_tags") > 0 THEN 'success'
    ELSE 'partial'
  END,
  "analysis_provider" = CASE WHEN nullif(btrim("ai_summary"), '') IS NOT NULL THEN 'legacy' ELSE NULL END,
  "analysis_version" = CASE WHEN nullif(btrim("ai_summary"), '') IS NOT NULL THEN 'legacy' ELSE NULL END,
  "analysis_attempts" = CASE WHEN nullif(btrim("ai_summary"), '') IS NOT NULL THEN 1 ELSE 0 END,
  "analyzed_at" = CASE WHEN nullif(btrim("ai_summary"), '') IS NOT NULL THEN "updated_at" ELSE NULL END;
