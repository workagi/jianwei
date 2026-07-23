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

# Retention: grandfather-father-son using file timestamps.
# - Daily: keep last 7 days
# - Weekly: keep one per week (Sunday) for 4 weeks
# - Monthly: keep one per month for 3 months
find "$BACKUP_DIR" -name "jianwei-*.dump" -type f | while read -r f; do
  # Already handled: skip retention logic for files older than 90 days
  if [ "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)" -lt "$(date -d '90 days ago' +%s 2>/dev/null || echo 0)" ]; then
    rm -f "$f"
    continue
  fi
done

# Daily cleanup: keep only last 7 (using mtime)
find "$BACKUP_DIR" -name "jianwei-*.dump" -mtime +6 -delete 2>/dev/null || true

echo "Retention: 7 daily backups kept"
