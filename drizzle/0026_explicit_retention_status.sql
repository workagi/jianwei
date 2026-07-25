-- Make Reader visibility an explicit monitor-match decision.
-- Historical Gate rejections used relevance_score = -1 as an implicit marker;
-- migrate those rows while keeping all other existing matches visible.

ALTER TABLE "item_matches"
ADD COLUMN "retention_status" text DEFAULT 'kept' NOT NULL;

UPDATE "item_matches"
SET "retention_status" = 'gate_blocked'
WHERE "relevance_score" < 0;

CREATE INDEX "item_matches_monitor_status_seen_idx"
ON "item_matches" USING btree ("monitor_id", "retention_status", "first_seen_at");
