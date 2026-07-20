ALTER TABLE "items" ADD COLUMN "content_provider" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "content_fetch_status" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "content_fetch_error" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "content_fetched_at" timestamp with time zone;