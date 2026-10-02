#!/bin/bash
# jianwei database backup script
# Usage: ./scripts/backup-db.sh [backup-dir]
# Default backup dir: ./backups

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_FILE="$BACKUP_DIR/jianwei-${TIMESTAMP}.dump"
LOG_FILE="${BACKUP_FILE}.log"
PROJECT="${JIANWEI_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-jianwei}}"
REMOTE_DUMP="/tmp/jianwei-dump-${TIMESTAMP}-$$.dump"

mkdir -p "$BACKUP_DIR"

# Select exactly the PostgreSQL service belonging to the intended Compose
# project. Name-based fuzzy matching can back up the wrong database when a
# host runs multiple Jianwei stacks (for example production plus staging).
CONTAINERS=$(docker ps -q \
  --filter "label=com.docker.compose.project=$PROJECT" \
  --filter 'label=com.docker.compose.service=postgres')
CONTAINER_COUNT=$(printf '%s\n' "$CONTAINERS" | grep -c . || true)

if [ "$CONTAINER_COUNT" -ne 1 ]; then
  echo "ERROR: Expected exactly one running postgres container for Compose project '$PROJECT'; found $CONTAINER_COUNT"
  echo "Set JIANWEI_COMPOSE_PROJECT when your deployment uses a different -p value."
  exit 1
fi
CONTAINER="$CONTAINERS"

echo "Backing up from container: $CONTAINER"

# Write to temp file first; log stderr separately so it never pollutes the dump.
TMP_FILE="$(mktemp)"
if docker exec "$CONTAINER" pg_dump -Fc -U monitor -d monitor --no-owner --no-acl \
  -f "$REMOTE_DUMP" 2>"$LOG_FILE"; then
  # Validate with the PostgreSQL tools already present in the database image.
  # The host only needs Docker; no separate pg_restore installation is required.
  if ! docker exec "$CONTAINER" pg_restore --list "$REMOTE_DUMP" >/dev/null 2>&1; then
    echo "ERROR: pg_dump produced a corrupt file"
    docker exec "$CONTAINER" rm -f "$REMOTE_DUMP"
    rm -f "$TMP_FILE"
    exit 1
  fi
  docker cp "$CONTAINER:$REMOTE_DUMP" "$TMP_FILE"
  docker exec "$CONTAINER" rm -f "$REMOTE_DUMP"
else
  echo "ERROR: pg_dump failed. See $LOG_FILE"
  cat "$LOG_FILE"
  rm -f "$TMP_FILE"
  exit 1
fi

mv "$TMP_FILE" "$BACKUP_FILE"

echo "Backup created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# ── Retention: grandfather-father-son ────────────────────────────────
# - Keep all backups from the last 7 days (daily).
# - Keep the newest backup per calendar week (Mon-Sun) for 4 weeks.
# - Keep the newest backup per calendar month for 3 months.
#
# Approach: mark files to keep, then delete everything else.

CUTOFF_DAILY=$(date -d "7 days ago" +%Y-%m-%d 2>/dev/null || date -v-7d +%Y-%m-%d)
FOUR_WEEKS_AGO=$(date -d "28 days ago" +%Y-%m-%d 2>/dev/null || date -v-28d +%Y-%m-%d)

KEEP_FILE="$(mktemp)"
SEEN_WEEKS="|"
SEEN_MONTHS="|"
FILES=("$BACKUP_DIR"/jianwei-*.dump)

mark_keep() {
  if ! grep -Fqx -- "$1" "$KEEP_FILE" 2>/dev/null; then
    printf '%s\n' "$1" >> "$KEEP_FILE"
  fi
}

# Glob order follows the timestamped filename, so walking backwards selects
# the newest backup in each week/month bucket. This stays compatible with the
# Bash 3.2 shipped by macOS (no associative arrays required).
for ((i=${#FILES[@]} - 1; i >= 0; i--)); do
  f="${FILES[$i]}"
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  # Extract date: jianwei-20260723T120000Z.dump → 2026-07-23
  FILE_DATE=$(echo "$BASENAME" | sed -n 's/^jianwei-\([0-9]\{8\}\)T.*/\1/p')
  [ -n "$FILE_DATE" ] || continue
  FORMATTED="${FILE_DATE:0:4}-${FILE_DATE:4:2}-${FILE_DATE:6:2}"

  # Rule 1: within last 7 days → always keep
  if [[ "$FORMATTED" > "$CUTOFF_DAILY" || "$FORMATTED" == "$CUTOFF_DAILY" ]]; then
    mark_keep "$f"
    continue
  fi

  # Rule 2: keep newest per calendar week (last 4 weeks)
  DOW=$(date -d "$FORMATTED" +%u 2>/dev/null || date -j -f "%Y-%m-%d" "$FORMATTED" +%u 2>/dev/null || echo 1)
  # Monday of that week
  WEEK_START=$(date -d "$FORMATTED - $((DOW - 1)) days" +%Y-%m-%d 2>/dev/null || \
               date -j -v-$((DOW - 1))d -f "%Y-%m-%d" "$FORMATTED" +%Y-%m-%d 2>/dev/null || echo "")
  if [ -n "$WEEK_START" ] && [[ "$WEEK_START" > "$FOUR_WEEKS_AGO" || "$WEEK_START" == "$FOUR_WEEKS_AGO" ]]; then
    BUCKET="week:$WEEK_START"
    if [[ "$SEEN_WEEKS" != *"|$BUCKET|"* ]]; then
      SEEN_WEEKS="${SEEN_WEEKS}${BUCKET}|"
      mark_keep "$f"
    fi
  fi

  # Rule 3: keep newest per calendar month (last 3 months)
  MONTH_KEY=$(echo "$FORMATTED" | cut -d- -f1-2)
  THREE_MONTHS_AGO=$(date -d "90 days ago" +%Y-%m 2>/dev/null || date -v-90d +%Y-%m)
  if [[ "$MONTH_KEY" > "$THREE_MONTHS_AGO" || "$MONTH_KEY" == "$THREE_MONTHS_AGO" ]]; then
    BUCKET="month:$MONTH_KEY"
    if [[ "$SEEN_MONTHS" != *"|$BUCKET|"* ]]; then
      SEEN_MONTHS="${SEEN_MONTHS}${BUCKET}|"
      mark_keep "$f"
    fi
  fi
done

# Delete anything not marked for keep.
DELETED=0
for f in "$BACKUP_DIR"/jianwei-*.dump; do
  [ -f "$f" ] || continue
  if ! grep -Fqx -- "$f" "$KEEP_FILE" 2>/dev/null; then
    rm -f "$f" "${f}.log" 2>/dev/null || true
    DELETED=$((DELETED + 1))
  fi
done

KEPT_COUNT=$(wc -l < "$KEEP_FILE" | tr -d ' ')
rm -f "$KEEP_FILE"
echo "Retention: $KEPT_COUNT backups kept, $DELETED deleted"
