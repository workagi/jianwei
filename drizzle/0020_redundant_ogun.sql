CREATE TABLE "monitor_match_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_item_id" uuid NOT NULL,
	"match_monitor_id" uuid NOT NULL,
	"source_item_id" uuid,
	"collection_run_id" uuid,
	"matched_query" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_match_observations" ADD CONSTRAINT "monitor_match_observations_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_match_observations" ADD CONSTRAINT "monitor_match_observations_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_observations_match_idx" ON "monitor_match_observations" USING btree ("match_item_id","match_monitor_id");--> statement-breakpoint
CREATE INDEX "match_observations_source_idx" ON "monitor_match_observations" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "match_observations_run_idx" ON "monitor_match_observations" USING btree ("collection_run_id");