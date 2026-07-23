-- 0025: Clean up legacy indexes on items table.
-- The unique constraint on (platform, upstream_id) and the relevance/retention
-- indexes are no longer needed — source_items enforces identity uniqueness and
-- item_matches carries per-monitor relevance/retention.

-- Already dropped in 0024_backfill_source_items.sql; this migration is a
-- placeholder for environments that apply migrations incrementally.
-- No schema changes are required.
