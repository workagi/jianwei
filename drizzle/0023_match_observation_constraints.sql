-- 0023: Tighten monitor_match_observations integrity

-- P1-10: Drop and recreate the unique index with NULLS NOT DISTINCT.
-- PostgreSQL treats NULLs as distinct values by default, so rows with
-- NULL source_item_id or NULL collection_run_id could be inserted
-- multiple times despite appearing to be duplicate observations.
DROP INDEX IF EXISTS "match_observations_run_match_source_uidx";
CREATE UNIQUE INDEX "match_observations_run_match_source_uidx"
  ON "monitor_match_observations"
  ("match_item_id", "match_monitor_id", "source_item_id", "collection_run_id")
  NULLS NOT DISTINCT;

-- P1-11: Ensure observations reference a real monitor-document match.
-- Without this FK, the database allows observation rows that point to
-- non-existent item_matches entries.
ALTER TABLE "monitor_match_observations"
  ADD CONSTRAINT "match_observations_match_fk"
  FOREIGN KEY ("match_item_id", "match_monitor_id")
  REFERENCES "item_matches" ("item_id", "monitor_id")
  ON DELETE CASCADE;
