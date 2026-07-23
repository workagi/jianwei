#!/usr/bin/env bash
# Stress test: create N monitors and simulate high backlog.
# Usage: ./scripts/stress-test.sh [monitor-count] [base-url]
set -euo pipefail

MONITOR_COUNT="${1:-30}"
BASE_URL="${2:-http://localhost:3000}"
API_TOKEN="${ADMIN_API_TOKEN:-test-token}"

echo "=== jianwei stress test: ${MONITOR_COUNT} monitors ==="

# Create web_search monitors with unique queries
echo "Creating ${MONITOR_COUNT} monitors..."
created=0
for i in $(seq 1 "${MONITOR_COUNT}"); do
  response=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/monitors" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"platform\": \"web_search\",
      \"name\": \"stress-test-${i}\",
      \"connectorId\": \"\",
      \"config\": {
        \"query\": \"AI news ${i}\",
        \"provider\": \"brave\"
      },
      \"pollIntervalMinutes\": 1
    }" 2>/dev/null || echo '{"error":"curl failed"}'$'\n'"500")

  http_code=$(echo "${response}" | tail -1)
  if [ "${http_code}" = "200" ] || [ "${http_code}" = "201" ]; then
    created=$((created + 1))
  fi
  # Show progress every 10
  if [ $((i % 10)) -eq 0 ]; then
    echo "  ${i}/${MONITOR_COUNT}..."
  fi
done
echo "  Created: ${created}/${MONITOR_COUNT}"

# Check health after creating monitors
echo ""
echo "Checking API health..."
for i in $(seq 1 5); do
  health=$(curl -sf "${BASE_URL}/api/health" 2>/dev/null || echo '{"ok":false}')
  echo "  Health check ${i}: ${health}"
  sleep 1
done

# Verify feeds still load
echo ""
echo "Verifying feeds..."
feeds=("/" "/?platform=web_search" "/?view=latest" "/?view=featured")
for feed in "${feeds[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}${feed}" 2>/dev/null || echo "000")
  echo "  ${feed}: HTTP ${code}"
done

# Verify admin still accessible
echo ""
echo "Verifying admin..."
admin_code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/admin" 2>/dev/null || echo "000")
echo "  /admin: HTTP ${admin_code}"

# Cleanup: disable all stress-test monitors
echo ""
echo "Cleaning up stress-test monitors..."
curl -sf -X POST "${BASE_URL}/api/monitors/bulk-disable" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"namePrefix\": \"stress-test\"}" 2>/dev/null || echo "  (bulk-disable not available, monitors will expire naturally)"

echo ""
echo "=== Stress test complete ==="
