#!/usr/bin/env bash
# Daily PostgreSQL backup for jianwei.
# Usage: ./scripts/backup-db.sh [backup-dir]
#   Default backup dir: ./backups
#   Set PGHOST, PGPORT, PGUSER, PGDATABASE via env or .env file.
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/jianwei-${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup] starting backup to ${BACKUP_FILE}"
pg_dump --no-owner --no-acl --compress=9 > "${BACKUP_FILE}" 2>&1

# Keep 7 daily backups, 4 weekly (Sunday), 3 monthly (1st)
echo "[backup] cleaning old backups..."
find "${BACKUP_DIR}" -name "jianwei-*.sql.gz" -type f | sort -r | tail -n +8 | while read -r old; do
  # Keep Sunday backups (weekly)
  if [[ "$(basename "${old}" .sql.gz)" =~ -Sun- ]]; then
    continue
  fi
  # Keep 1st-of-month (monthly)
  if [[ "$(basename "${old}" .sql.gz)" =~ -01T ]]; then
    continue
  fi
  echo "  removing ${old}"
  rm -f "${old}"
done

echo "[backup] done: $(du -h "${BACKUP_FILE}" | cut -f1)"
