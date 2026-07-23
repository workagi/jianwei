#!/bin/bash
# jianwei database backup script
# Usage: ./scripts/backup-db.sh [backup-dir]
# Default backup dir: ./backups

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_FILE="$BACKUP_DIR/jianwei-${TIMESTAMP}.dump"
LOG_FILE="${BACKUP_FILE}.log"

mkdir -p "$BACKUP_DIR"

# Find the running postgres container
CONTAINER=$(docker ps --format '{{.Names}}' | grep -E 'jianwei.*postgres|postgres.*jianwei' | head -1)

if [ -z "$CONTAINER" ]; then
  echo "ERROR: No running jianwei postgres container found"
  exit 1
fi

echo "Backing up from container: $CONTAINER"

# Write to temp file first; log stderr separately so it never pollutes the dump.
TMP_FILE="$(mktemp)"
if docker exec "$CONTAINER" pg_dump -Fc -U postgres -d monitor --no-owner --no-acl \
  -f /tmp/jianwei-dump.tmp 2>"$LOG_FILE"; then
  docker cp "$CONTAINER:/tmp/jianwei-dump.tmp" "$TMP_FILE"
  docker exec "$CONTAINER" rm -f /tmp/jianwei-dump.tmp
else
  echo "ERROR: pg_dump failed. See $LOG_FILE"
  cat "$LOG_FILE"
  rm -f "$TMP_FILE"
  exit 1
fi

# Verify the dump is restorable
if pg_restore --list "$TMP_FILE" >/dev/null 2>&1; then
  mv "$TMP_FILE" "$BACKUP_FILE"
else
  echo "ERROR: pg_dump produced a corrupt file"
  rm -f "$TMP_FILE"
  exit 1
fi

echo "Backup created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# ── Retention: grandfather-father-son ────────────────────────────────
# - Keep all backups from the last 7 days (daily).
# - Keep the newest backup per calendar week (Mon-Sun) for 4 weeks.
# - Keep the newest backup per calendar month for 3 months.
#
# Approach: mark files to keep, then delete everything else.

TODAY=$(date +%Y-%m-%d)
CUTOFF_DAILY=$(date -d "7 days ago" +%Y-%m-%d 2>/dev/null || date -v-7d +%Y-%m-%d)
FOUR_WEEKS_AGO=$(date -d "28 days ago" +%Y-%m-%d 2>/dev/null || date -v-28d +%Y-%m-%d)

declare -A KEEP=()
declare -A KEPT_BUCKET_MTIME=()

for f in "$BACKUP_DIR"/jianwei-*.dump; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  # Extract date: jianwei-20260723T120000Z.dump → 2026-07-23
  FILE_DATE=$(echo "$BASENAME" | sed -n 's/^jianwei-\([0-9]\{8\}\)T.*/\1/p')
  [ -n "$FILE_DATE" ] || continue
  FORMATTED=$(echo "$FILE_DATE" | sed 's/\(....\)\(..\)\(..\)/\1-\2-\3/')

  # Rule 1: within last 7 days → always keep
  if [[ "$FORMATTED" > "$CUTOFF_DAILY" || "$FORMATTED" == "$CUTOFF_DAILY" ]]; then
    KEEP["$f"]=1
    continue
  fi

  # Rule 2: keep newest per calendar week (last 4 weeks)
  DOW=$(date -d "$FORMATTED" +%u 2>/dev/null || date -j -f "%Y-%m-%d" "$FORMATTED" +%u 2>/dev/null || echo 1)
  # Monday of that week
  WEEK_START=$(date -d "$FORMATTED - $((DOW - 1)) days" +%Y-%m-%d 2>/dev/null || \
               date -j -v-$((DOW - 1))d -f "%Y-%m-%d" "$FORMATTED" +%Y-%m-%d 2>/dev/null || echo "")
  if [ -n "$WEEK_START" ] && [[ "$WEEK_START" > "$FOUR_WEEKS_AGO" || "$WEEK_START" == "$FOUR_WEEKS_AGO" ]]; then
    BUCKET="week:$WEEK_START"
    MTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    if [ -z "${KEPT_BUCKET_MTIME[$BUCKET]}" ] || [ "$MTIME" -gt "${KEPT_BUCKET_MTIME[$BUCKET]}" ]; then
      KEPT_BUCKET_MTIME[$BUCKET]="$MTIME"
      KEEP["$f"]=1
    fi
  fi

  # Rule 3: keep newest per calendar month (last 3 months)
  MONTH_KEY=$(echo "$FORMATTED" | cut -d- -f1-2)
  THREE_MONTHS_AGO=$(date -d "90 days ago" +%Y-%m 2>/dev/null || date -v-90d +%Y-%m)
  if [[ "$MONTH_KEY" > "$THREE_MONTHS_AGO" || "$MONTH_KEY" == "$THREE_MONTHS_AGO" ]]; then
    BUCKET="month:$MONTH_KEY"
    MTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    if [ -z "${KEPT_BUCKET_MTIME[$BUCKET]}" ] || [ "$MTIME" -gt "${KEPT_BUCKET_MTIME[$BUCKET]}" ]; then
      KEPT_BUCKET_MTIME[$BUCKET]="$MTIME"
      KEEP["$f"]=1
    fi
  fi
done

# Delete anything not marked for keep.
DELETED=0
for f in "$BACKUP_DIR"/jianwei-*.dump; do
  [ -f "$f" ] || continue
  if [ -z "${KEEP[$f]}" ]; then
    rm -f "$f" "${f}.log" 2>/dev/null || true
    DELETED=$((DELETED + 1))
  fi
done

echo "Retention: ${#KEEP[@]} backups kept, $DELETED deleted"
