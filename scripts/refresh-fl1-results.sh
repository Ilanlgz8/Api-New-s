#!/bin/bash
#
# Refresh FL1 results snapshot automatically
# Usage: ./refresh-fl1-results.sh
# Or setup in crontab: */30 * * * * /path/to/refresh-fl1-results.sh
#

set -o pipefail

# Configuration
API_BASE="${API_BASE:-http://localhost:3001}"
ADMIN_SECRET="${ADMIN_REFRESH_SECRET:-}"
COMPETITION="FL1"
DAYS_BACK=${DAYS_BACK:-30}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${LOG_FILE:-$SCRIPT_DIR/../fl1-refresh.log}"

# Log function
log() {
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] $*" >> "$LOG_FILE"
}

# Main refresh function
refresh_fl1() {
  log "Starting FL1 refresh (window: -${DAYS_BACK}→0)..."
  
  # Build curl headers
  local headers="-H 'Content-Type: application/json'"
  if [ -n "$ADMIN_SECRET" ]; then
    headers="$headers -H 'x-admin-secret: $ADMIN_SECRET'"
  fi
  
  # Call targeted refresh endpoint
  local response=$(eval "curl -s -X POST '$API_BASE/api/football/refresh-results/targeted' \
    $headers \
    -d '{\"code\":\"$COMPETITION\",\"from\":-$DAYS_BACK,\"to\":0}'" 2>&1)
  
  local exit_code=$?
  
  if [ $exit_code -ne 0 ]; then
    log "ERROR: curl failed with exit code $exit_code"
    log "Response: $response"
    return 1
  fi
  
  # Parse response
  local ok=$(echo "$response" | grep -o '"ok":true' | head -1)
  if [ -z "$ok" ]; then
    log "ERROR: API returned failure"
    log "Response: $response"
    return 1
  fi
  
  # Extract counts
  local count=$(echo "$response" | grep -o '"count":[0-9]*' | cut -d: -f2)
  local merged=$(echo "$response" | grep -o '"mergedCount":[0-9]*' | cut -d: -f2)
  
  log "✓ FL1 refresh complete: $count FL1 matches, $merged total (merged snapshot)"
  return 0
}

# Run refresh
refresh_fl1
exit $?
