#!/usr/bin/env bash
# Fail when schema.ts no longer matches the latest committed Drizzle snapshot.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R "$ROOT_DIR/drizzle" "$TMP_DIR/drizzle"

(
  cd "$TMP_DIR"
  "$ROOT_DIR/node_modules/.bin/drizzle-kit" generate \
    --out drizzle \
    --schema "$ROOT_DIR/src/db/schema.ts" \
    --dialect postgresql \
    --name schema_drift
)

if find "$TMP_DIR/drizzle" -maxdepth 1 -name '*_schema_drift.sql' -print -quit | grep -q .; then
  echo "ERROR: src/db/schema.ts differs from the committed migration snapshots."
  echo "Run 'pnpm db:generate', inspect the migration, and commit it."
  exit 1
fi

echo "Schema metadata and migration snapshots are in sync."
