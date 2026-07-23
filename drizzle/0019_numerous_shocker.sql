ALTER TABLE "collection_runs" ADD COLUMN "current_stage" text;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD COLUMN "last_progress_at" timestamp with time zone DEFAULT now() NOT NULL;