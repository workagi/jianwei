ALTER TABLE "monitors" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "collection_runs_monitor_started_idx" ON "collection_runs" USING btree ("monitor_id","started_at");--> statement-breakpoint
CREATE INDEX "collection_runs_status_started_idx" ON "collection_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "item_matches_monitor_seen_idx" ON "item_matches" USING btree ("monitor_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "monitors_lease_idx" ON "monitors" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX "usage_ledger_connector_time_idx" ON "usage_ledger" USING btree ("connector_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_metric_time_idx" ON "usage_ledger" USING btree ("metric","occurred_at");