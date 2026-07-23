#!/usr/bin/env bash
# DB upgrade test: apply old migrations, upgrade, verify
set -euo pipefail

echo "=== DB Upgrade Test ==="

# Apply baseline migrations (0000-0010, representing v0.1.0 schema)
echo "Applying baseline migrations (0000-0010)..."
for f in drizzle/0000_*.sql drizzle/0001_*.sql drizzle/0002_*.sql drizzle/0003_*.sql \
         drizzle/0004_*.sql drizzle/0005_*.sql drizzle/0006_*.sql drizzle/0007_*.sql \
         drizzle/0008_*.sql drizzle/0009_*.sql drizzle/0010_*.sql; do
  echo "  $f"
  psql "$DATABASE_URL" -f "$f" -q
done

echo "Recording baseline state..."
psql "$DATABASE_URL" -t -c "SELECT count(*) FROM items;" > /tmp/baseline_items_count.txt
echo "Baseline items: $(cat /tmp/baseline_items_count.txt)"

# Run full migration (applies 0011+)
echo "Running pnpm db:migrate..."
pnpm db:migrate

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
