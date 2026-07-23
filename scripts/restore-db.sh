#!/bin/bash
# jianwei database restore script
# Usage: ./scripts/restore-db.sh <backup-file.sql.gz>

set -euo pipefail

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup-file.sql.gz>"
  echo "Available backups:"
  ls -lh backups/*.sql.gz 2>/dev/null || echo "  (none found in ./backups)"
  exit 1
fi

CONTAINER=$(docker ps --format '{{.Names}}' | grep -E 'jianwei.*postgres|postgres.*jianwei' | head -1)

if [ -z "$CONTAINER" ]; then
  echo "ERROR: No running jianwei postgres container found"
  exit 1
fi

echo "WARNING: This will REPLACE all data in the 'monitor' database."
echo "Container: $CONTAINER"
echo "Backup:    $BACKUP_FILE"
read -rp "Type 'YES' to confirm: " confirm
if [ "$confirm" != "YES" ]; then
  echo "Aborted."
  exit 0
fi

echo "Restoring database..."
gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -U postgres -d monitor

echo "Restore complete. Restarting web and worker..."
docker compose -f docker-compose.prod.yml restart web worker

echo "Done. Check service health at /api/health"
