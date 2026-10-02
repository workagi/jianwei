#!/bin/bash
# jianwei database restore script
# Usage: ./scripts/restore-db.sh <backup-file.dump>

set -euo pipefail

BACKUP_FILE="${1:-}"
PROJECT="${JIANWEI_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-jianwei}}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup-file.dump>"
  echo "Available backups:"
  ls -lh backups/*.dump 2>/dev/null || echo "  (none found in ./backups)"
  exit 1
fi

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

echo "WARNING: This will REPLACE all data in the 'monitor' database."
echo "Container: $CONTAINER"
echo "Backup:    $BACKUP_FILE"
read -rp "Type 'YES' to confirm: " confirm
if [ "$confirm" != "YES" ]; then
  echo "Aborted."
  exit 0
fi

echo "Restoring database..."
RESTORE_PATH="/tmp/jianwei-restore-$$.dump"
APP_CONTAINERS=""
if [ -n "$PROJECT" ]; then
  APP_CONTAINERS=$(docker ps -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter 'label=com.docker.compose.service=web')
  APP_CONTAINERS="$APP_CONTAINERS $(docker ps -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter 'label=com.docker.compose.service=worker')"
fi

cleanup() {
  docker exec "$CONTAINER" rm -f "$RESTORE_PATH" >/dev/null 2>&1 || true
  if [ -n "${APP_CONTAINERS// /}" ]; then
    # shellcheck disable=SC2086 # container IDs must be separate arguments
    docker start $APP_CONTAINERS >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -n "${APP_CONTAINERS// /}" ]; then
  echo "Stopping web and worker during restore..."
  # shellcheck disable=SC2086 # container IDs must be separate arguments
  docker stop $APP_CONTAINERS >/dev/null
fi

docker cp "$BACKUP_FILE" "$CONTAINER:$RESTORE_PATH"
docker exec "$CONTAINER" pg_restore --list "$RESTORE_PATH" >/dev/null
docker exec "$CONTAINER" pg_restore \
  --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction \
  -U monitor -d monitor "$RESTORE_PATH"

echo "Restore complete. Restarting web and worker..."
cleanup
trap - EXIT

echo "Done. Check service health at /api/health"
