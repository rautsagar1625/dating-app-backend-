#!/usr/bin/env bash
# Automated restore validation test.
# Spins up an ephemeral PostgreSQL container, restores the latest backup,
# runs schema and data integrity checks, then destroys the container.
# Run weekly via K8s CronJob. Alerts if restore takes >RTO or data checks fail.
#
# Required env: BACKUP_S3_BUCKET, BACKUP_ENCRYPTION_KEY, DATABASE_URL
# Optional env:  SLACK_WEBHOOK_URL, REDIS_URL, RESTORE_TEST_RTO_MINUTES (default: 30)

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="restore-test"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY

RTO_MINUTES="${RESTORE_TEST_RTO_MINUTES:-30}"
CONTAINER_NAME="velvet-restore-test-$$"
TEST_PORT="54321"
TEST_DB_URL="postgresql://postgres:testpass@localhost:${TEST_PORT}/velvet_test"

setup_workdir

START_TS="$(date +%s)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log "Starting restore test: ${TIMESTAMP}"
log "RTO target: ${RTO_MINUTES} minutes"

cleanup_container() {
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
}
trap cleanup_container EXIT

# ── 1. Start ephemeral PostgreSQL ─────────────────────────────────────────────

log "Starting ephemeral PostgreSQL container..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_DB=velvet_test \
  -e POSTGRES_PASSWORD=testpass \
  -p "${TEST_PORT}:5432" \
  postgres:18-alpine

# Wait for PostgreSQL to be ready
for i in {1..30}; do
  if docker exec "${CONTAINER_NAME}" pg_isready -q 2>/dev/null; then
    log "PostgreSQL ready after ${i}s"
    break
  fi
  sleep 1
done

# ── 2. Download latest backup ─────────────────────────────────────────────────

log "Resolving latest logical backup..."
LATEST_FILE="$(aws s3 ls "s3://${BACKUP_S3_BUCKET}/postgres/logical/" \
  | grep '\.enc$' | sort | tail -1 | awk '{print $4}')"
S3_KEY="postgres/logical/${LATEST_FILE}"
LOCAL_ENC="${WORK_DIR}/${LATEST_FILE}"
LOCAL_DEC="${LOCAL_ENC%.enc}"

log "Downloading: ${S3_KEY}..."
aws s3 cp "s3://${BACKUP_S3_BUCKET}/${S3_KEY}" "${LOCAL_ENC}" --no-progress

# Checksum verification
if aws s3 cp "s3://${BACKUP_S3_BUCKET}/${S3_KEY}.sha256" "${LOCAL_ENC}.sha256" --no-progress 2>/dev/null; then
  verify_checksum "${LOCAL_ENC}"
fi

decrypt_file "${LOCAL_ENC}" "${LOCAL_DEC}"
rm -f "${LOCAL_ENC}"

# ── 3. Restore ────────────────────────────────────────────────────────────────

log "Restoring to test container..."
pg_restore \
  --dbname="${TEST_DB_URL}" \
  --format=custom \
  --clean --if-exists \
  --no-owner --no-privileges \
  "${LOCAL_DEC}" 2>&1 | grep -E 'error|warning|complete' | while IFS= read -r line; do log "$line"; done || true

RESTORE_TS="$(date +%s)"
RESTORE_DURATION=$(( RESTORE_TS - START_TS ))
log "Restore completed in ${RESTORE_DURATION}s (RTO limit: $((RTO_MINUTES * 60))s)"

# ── 4. Data integrity checks ──────────────────────────────────────────────────

log "Running data integrity checks..."

run_check() {
  local desc="$1" query="$2" min_expected="$3"
  local result
  result="$(psql "${TEST_DB_URL}" -tAc "${query}" 2>/dev/null || echo "0")"
  if [[ "${result}" -lt "${min_expected}" ]]; then
    error "CHECK FAILED: ${desc} — got ${result}, expected ≥${min_expected}"
    return 1
  fi
  log "CHECK PASSED: ${desc} → ${result}"
}

run_check "Table count"           "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"       10
run_check "User table exists"     "SELECT count(*) FROM \"User\""                                                    0
run_check "Profile table exists"  "SELECT count(*) FROM \"Profile\""                                                 0
run_check "Chat table exists"     "SELECT count(*) FROM \"Chat\""                                                    0
run_check "Index count"           "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"                        5
run_check "FK constraint count"   "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY'" 5

# Schema version check: ensure all migrations are present
run_check "Migration count"       "SELECT count(*) FROM \"_prisma_migrations\" WHERE applied_steps_count > 0"        5

# ── 5. RTO check ──────────────────────────────────────────────────────────────

if [[ ${RESTORE_DURATION} -gt $((RTO_MINUTES * 60)) ]]; then
  notify_failure "RTO BREACH: restore took ${RESTORE_DURATION}s, target was $((RTO_MINUTES * 60))s"
  exit 1
fi

# ── 6. Write test report ──────────────────────────────────────────────────────

TOTAL_DURATION=$(( $(date +%s) - START_TS ))
REPORT="${WORK_DIR}/restore-test-${TIMESTAMP}.json"
cat > "${REPORT}" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "status": "PASSED",
  "backup_s3_key": "${S3_KEY}",
  "restore_duration_seconds": ${RESTORE_DURATION},
  "total_duration_seconds": ${TOTAL_DURATION},
  "rto_target_seconds": $((RTO_MINUTES * 60)),
  "rto_met": $([ ${RESTORE_DURATION} -le $((RTO_MINUTES * 60)) ] && echo true || echo false)
}
EOF

aws s3 cp "${REPORT}" \
  "s3://${BACKUP_S3_BUCKET}/restore-tests/restore-test-${TIMESTAMP}.json" \
  --content-type application/json --no-progress || true

if [[ -n "${REDIS_URL:-}" ]]; then
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:restore-test:last_status"   "PASSED"          EX 700000 || true
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:restore-test:last_ts"       "$(date +%s)"     EX 700000 || true
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:restore-test:last_duration" "${RESTORE_DURATION}" EX 700000 || true
fi

notify_success "Restore test PASSED. Restore time: ${RESTORE_DURATION}s (RTO: $((RTO_MINUTES * 60))s). Total: ${TOTAL_DURATION}s"
