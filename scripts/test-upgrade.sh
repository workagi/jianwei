#!/usr/bin/env bash
# Upgrade a populated 0023 database to the current schema and verify that the
# data migrations and constraints work. This intentionally does not start from
# an empty current database: it exercises the same boundary an older install
# crosses during an upgrade.
set -euo pipefail

BASELINE_TAG="0023_match_observation_constraints"
BASELINE_WHEN="1784795146644"

echo "=== DB Upgrade Test (${BASELINE_TAG} -> current) ==="

echo "Applying baseline migrations (0000-0023)..."
for migration in drizzle/*.sql; do
  tag="$(basename "$migration" .sql)"
  prefix="${tag%%_*}"
  if ((10#$prefix > 23)); then
    break
  fi
  echo "  $migration"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

# Tell Drizzle that the hand-built fixture is at migration 0023. The migrator
# orders migrations by the journal timestamp, so it will now execute 0024+.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('upgrade-fixture-${BASELINE_TAG}', ${BASELINE_WHEN});
SQL

echo "Seeding representative legacy rows..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO connectors (id, platform, provider, name)
VALUES ('11111111-1111-4111-8111-111111111111', 'wechat', 'legacy_test', 'Legacy connector');

INSERT INTO monitors (id, platform, connector_id, name, config)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'wechat',
  '11111111-1111-4111-8111-111111111111',
  'Legacy monitor',
  '{}'::jsonb
);

-- Insert after 0015's original backfill so 0024 must migrate this row.
INSERT INTO items (
  id, platform, source_provider, upstream_id, canonical_url,
  body_text, published_at, content_hash
) VALUES (
  '33333333-3333-4333-8333-333333333333',
  'wechat',
  'legacy_test',
  'legacy-upstream-1',
  'https://example.invalid/legacy-article',
  'legacy body',
  '2026-07-23T00:00:00Z',
  'legacy-content-hash'
);

-- 0026 must convert this historical implicit Gate marker to an explicit state.
INSERT INTO item_matches (item_id, monitor_id, relevance_score)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  -1
);
SQL

echo "Running current migrations..."
pnpm db:migrate

echo "Verifying upgraded data and schema..."
test "$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM source_items WHERE item_id = '33333333-3333-4333-8333-333333333333' AND source_provider = 'legacy_test' AND upstream_id = 'legacy-upstream-1'")" = "1"
echo "  ✓ legacy source identity backfilled"

test "$(psql "$DATABASE_URL" -Atc "SELECT retention_status FROM item_matches WHERE item_id = '33333333-3333-4333-8333-333333333333' AND monitor_id = '22222222-2222-4222-8222-222222222222'")" = "gate_blocked"
echo "  ✓ legacy Gate decision migrated"

for legacy_index in items_platform_upstream_uidx items_source_provider_idx items_relevance_score_idx; do
  if psql "$DATABASE_URL" -Atc "SELECT 1 FROM pg_indexes WHERE indexname = '$legacy_index'" | grep -q 1; then
    echo "  ✗ legacy index still exists: $legacy_index"
    exit 1
  fi
done
echo "  ✓ obsolete item identity/relevance indexes removed"

for table in items item_matches source_items collection_runs monitors api_credentials \
             usage_ledger runtime_health login_attempts monitor_match_observations \
             connectors bookmarks document_analysis_claims \
             content_events event_items model_receipts model_attempts; do
  if ! psql "$DATABASE_URL" -Atc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$table'" | grep -q 1; then
    echo "  ✗ $table MISSING"
    exit 1
  fi
done
echo "  ✓ required tables present"

for col_check in \
  "monitors:lease_epoch" \
  "collection_runs:attempt_token" \
  "collection_runs:current_stage" \
  "collection_runs:last_progress_at" \
  "item_matches:retention_status" \
  "document_analysis_claims:claim_token" \
  "monitor_match_observations:observation_key" \
  "items:editorial_reason"; do
  table="${col_check%%:*}"
  col="${col_check##*:}"
  if ! psql "$DATABASE_URL" -Atc "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$table' AND column_name='$col'" | grep -q 1; then
    echo "  ✗ $table.$col MISSING"
    exit 1
  fi
done
echo "  ✓ current coordination columns present"

test "$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM drizzle.__drizzle_migrations")" = "6"
echo "  ✓ migration journal advanced exactly through 0028"

echo "=== Upgrade test PASSED ==="
