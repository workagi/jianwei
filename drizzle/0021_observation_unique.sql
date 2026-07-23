-- Add unique constraint to prevent duplicate observations
-- Each collection run can only observe a given source for a given match once.
ALTER TABLE monitor_match_observations
  ADD CONSTRAINT monitor_match_observations_run_match_source_uidx
  UNIQUE (match_item_id, match_monitor_id, source_item_id, collection_run_id);
