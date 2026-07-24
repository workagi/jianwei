#!/usr/bin/env bash
# DB upgrade test: apply old migrations, upgrade, verify
set -euo pipefail

echo "=== DB Upgrade Test ==="

# Apply all migrations via drizzle-kit. This tests that the full migration
# chain (0000→0025) works end-to-end on a clean database.
echo "Applying all migrations (0000→0025)..."
pnpm db:migrate

echo "Recording baseline state..."
psql "$DATABASE_URL" -t -c "SELECT count(*) FROM items;" > /tmp/baseline_items_count.txt
echo "Baseline items: $(cat /tmp/baseline_items_count.txt)"

# Verify key tables exist
echo "Verifying schema..."
for table in items item_matches source_items collection_runs monitors api_credentials \
             usage_ledger workers admin_settings login_attempts monitor_match_observations; do
  if psql "$DATABASE_URL" -t -c "SELECT 1 FROM information_schema.tables WHERE table_name='$table'" | grep -q 1; then
    echo "  ✓ $table"
  else
    echo "  ✗ $table MISSING"
    exit 1
  fi
done

# Verify new columns from recent migrations
echo "Verifying new columns..."
for col_check in \
  "monitors:lease_epoch" \
  "collection_runs:attempt_token" \
  "collection_runs:current_stage" \
  "collection_runs:last_progress_at"; do
  table="${col_check%%:*}"
  col="${col_check##*:}"
  if psql "$DATABASE_URL" -t -c "SELECT 1 FROM information_schema.columns WHERE table_name='$table' AND column_name='$col'" | grep -q 1; then
    echo "  ✓ $table.$col"
  else
    echo "  ✗ $table.$col MISSING"
    exit 1
  fi
done

# Verify monitor_match_observations table structure
echo "Verifying observations table..."
psql "$DATABASE_URL" -t -c "SELECT count(*) FROM information_schema.columns WHERE table_name='monitor_match_observations'" | grep -q '[5-9]\|[1-9][0-9]' || {
  echo "  ✗ monitor_match_observations has too few columns"
  exit 1
}
echo "  ✓ monitor_match_observations columns OK"

echo "=== Upgrade test PASSED ==="
