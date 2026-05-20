#!/usr/bin/env bash
# Redis backup: triggers BGSAVE, waits for completion, copies RDB to S3.
# Redis AOF + RDB persistence must be enabled in redis.conf (see redis-persistence.conf).
#
# Required env: REDIS_URL, BACKUP_S3_BUCKET, BACKUP_ENCRYPTION_KEY
# Optional env:  REDIS_RDB_PATH (default: /data/dump.rdb), SLACK_WEBHOOK_URL, REDIS_URL

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="redis"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env REDIS_URL BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY

setup_workdir

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RDB_PATH="${REDIS_RDB_PATH:-/data/dump.rdb}"
FILENAME="velvet-redis-${TIMESTAMP}.rdb"
ENCRYPTED="${FILENAME}.enc"
LOCAL_RDB="${WORK_DIR}/${FILENAME}"
LOCAL_ENC="${WORK_DIR}/${ENCRYPTED}"
S3_KEY="redis/${ENCRYPTED}"

log "Starting Redis backup: ${TIMESTAMP}"

# ── 1. Trigger BGSAVE and wait ────────────────────────────────────────────────

log "Issuing BGSAVE..."
redis-cli -u "${REDIS_URL}" BGSAVE

# Poll until save is complete (last_bgsave_status = ok, rdb_bgsave_in_progress = 0)
TIMEOUT=120
ELAPSED=0
while true; do
  IN_PROGRESS="$(redis-cli -u "${REDIS_URL}" INFO persistence | grep 'rdb_bgsave_in_progress' | tr -d '\r' | cut -d: -f2)"
  STATUS="$(redis-cli -u "${REDIS_URL}" INFO persistence | grep 'rdb_last_bgsave_status' | tr -d '\r' | cut -d: -f2)"

  if [[ "${IN_PROGRESS}" == "0" ]]; then
    if [[ "${STATUS}" != "ok" ]]; then
      notify_failure "BGSAVE completed with status: ${STATUS}"
      exit 1
    fi
    log "BGSAVE complete. Status: ${STATUS}"
    break
  fi

  if [[ ${ELAPSED} -ge ${TIMEOUT} ]]; then
    notify_failure "BGSAVE timed out after ${TIMEOUT}s"
    exit 1
  fi

  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# ── 2. Copy RDB file ──────────────────────────────────────────────────────────

if [[ ! -f "${RDB_PATH}" ]]; then
  notify_failure "RDB file not found at ${RDB_PATH}"
  exit 1
fi

cp "${RDB_PATH}" "${LOCAL_RDB}"
RDB_SIZE="$(stat -c%s "${LOCAL_RDB}" 2>/dev/null || stat -f%z "${LOCAL_RDB}")"
log "RDB copied. Size: ${RDB_SIZE} bytes"

# ── 3. Also dump Redis keyspace stats for monitoring ──────────────────────────

redis-cli -u "${REDIS_URL}" INFO all > "${WORK_DIR}/redis-info-${TIMESTAMP}.txt" || true
redis-cli -u "${REDIS_URL}" DBSIZE >> "${WORK_DIR}/redis-info-${TIMESTAMP}.txt" || true

# ── 4. Encrypt ────────────────────────────────────────────────────────────────

encrypt_file "${LOCAL_RDB}" "${LOCAL_ENC}"
rm -f "${LOCAL_RDB}"

# ── 5. Checksum + Upload ──────────────────────────────────────────────────────

write_checksum "${LOCAL_ENC}"

if ! s3_upload "${LOCAL_ENC}" "${S3_KEY}"; then
  notify_failure "S3 upload failed for Redis backup"
  exit 1
fi

# Upload info dump (unencrypted — no sensitive data, useful for forensics)
aws s3 cp "${WORK_DIR}/redis-info-${TIMESTAMP}.txt" \
  "s3://${BACKUP_S3_BUCKET}/redis/info/redis-info-${TIMESTAMP}.txt" \
  --storage-class STANDARD --no-progress || true

# ── 6. Record success ─────────────────────────────────────────────────────────

record_backup_success "redis" "${RDB_SIZE}" "${S3_KEY}"
notify_success "Redis backup complete. RDB size: ${RDB_SIZE} bytes. Key: ${S3_KEY}"
