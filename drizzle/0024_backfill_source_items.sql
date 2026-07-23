-- 0024: Backfill source_items from legacy items fields and prepare for removal.

-- Step 1: Backfill any items that don't have a corresponding source_item.
-- This ensures every item has at least one source observation.
INSERT INTO source_items (item_id, platform, source_provider, upstream_id, source_url, raw_payload, first_seen_at, last_seen_at)
SELECT
  i.id,
  i.platform,
  COALESCE(i.source_provider, i.platform::text),
  i.upstream_id,
  COALESCE(i.canonical_url, 'signaldeck:orphan:' || i.id::text),
  '{}'::jsonb,
  COALESCE(i.fetched_at, i.created_at, now()),
  COALESCE(i.updated_at, now())
FROM items i
WHERE NOT EXISTS (
  SELECT 1 FROM source_items si
  WHERE si.item_id = i.id
    AND si.platform = i.platform
    AND si.upstream_id = i.upstream_id
);

-- Step 2: Drop the legacy unique constraint on items(platform, upstreamId).
-- Source identity uniqueness is now enforced by source_items_identity_uidx.
DROP INDEX IF EXISTS "items_platform_upstream_uidx";

-- Step 3: Drop legacy relevance/retention indexes (data lives on item_matches now).
DROP INDEX IF EXISTS "items_relevance_score_idx";
DROP INDEX IF EXISTS "items_source_provider_idx";
