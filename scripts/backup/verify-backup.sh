#!/usr/bin/env bash
# Backup integrity verification.
# Downloads the latest backup of each type, verifies checksum, attempts partial restore.
# Runs daily after backups complete. Alerts on any integrity failure.
#
# Required env: BACKUP_S3_BUCKET, BACKUP_ENCRYPTION_KEY
# Optional env:  SLACK_WEBHOOK_URL, REDIS_URL

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="verify"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY

setup_workdir

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OVERALL_STATUS="OK"
declare -A CHECK_RESULTS

log "Starting backup integrity verification: ${TIMESTAMP}"

# ── Helper: verify one backup ─────────────────────────────────────────────────

verify_one() {
  local backup_type="$1" s3_prefix="$2" file_pattern="$3"
  log "Verifying ${backup_type} backup..."

  # Find the latest encrypted backup file in S3
  local latest_key
  latest_key="$(aws s3 ls "s3://${BACKUP_S3_BUCKET}/${s3_prefix}/" \
    | grep "${file_pattern}" \
    | sort | tail -1 | awk '{print $4}')"

  if [[ -z "${latest_key}" ]]; then
    warn "${backup_type}: No backup found under s3://${BACKUP_S3_BUCKET}/${s3_prefix}/"
    CHECK_RESULTS["${backup_type}"]="MISSING"
    OVERALL_STATUS="FAILED"
    return
  fi

  local full_key="${s3_prefix}/${latest_key}"
  local local_enc="${WORK_DIR}/${latest_key}"
  local local_dec="${local_enc%.enc}"

  # Download
  log "${backup_type}: Downloading ${full_key}..."
  aws s3 cp "s3://${BACKUP_S3_BUCKET}/${full_key}" "${local_enc}" --no-progress

  # Checksum verification
  if aws s3 cp "s3://${BACKUP_S3_BUCKET}/${full_key}.sha256" "${local_enc}.sha256" --no-progress 2>/dev/null; then
    if ! verify_checksum "${local_enc}"; then
      CHECK_RESULTS["${backup_type}"]="CHECKSUM_FAIL"
      OVERALL_STATUS="FAILED"
      return
    fi
  else
    warn "${backup_type}: No checksum file found — skipping checksum verification"
  fi

  # Decryption test
  if ! decrypt_file "${local_enc}" "${local_dec}"; then
    CHECK_RESULTS["${backup_type}"]="DECRYPT_FAIL"
    OVERALL_STATUS="FAILED"
    return
  fi

  # File-type specific sanity check
  case "${backup_type}" in
    pg-logical)
      if ! pg_restore --list "${local_dec}" &>/dev/null; then
        CHECK_RESULTS["${backup_type}"]="PG_RESTORE_LIST_FAIL"
        OVERALL_STATUS="FAILED"
        return
      fi
      local table_count
      table_count="$(pg_restore --list "${local_dec}" | grep -c 'TABLE DATA' || true)"
      log "${backup_type}: pg_restore list OK. TABLE DATA sections: ${table_count}"
      ;;
    redis)
      # redis-check-rdb validates RDB file structure without loading it
      if command -v redis-check-rdb &>/dev/null; then
        if ! redis-check-rdb "${local_dec}" 2>&1 | grep -q 'RDB looks OK'; then
          CHECK_RESULTS["${backup_type}"]="RDB_CORRUPT"
          OVERALL_STATUS="FAILED"
          return
        fi
        log "${backup_type}: RDB integrity OK"
      else
        # Fallback: check file size > 0 and starts with REDIS magic bytes
        local magic
        magic="$(head -c 5 "${local_dec}" 2>/dev/null || true)"
        if [[ "${magic}" != "REDIS" ]]; then
          CHECK_RESULTS["${backup_type}"]="RDB_BAD_MAGIC"
          OVERALL_STATUS="FAILED"
          return
        fi
        log "${backup_type}: RDB magic bytes OK (redis-check-rdb not available)"
      fi
      ;;
  esac

  local file_size
  file_size="$(stat -c%s "${local_dec}" 2>/dev/null || stat -f%z "${local_dec}")"
  CHECK_RESULTS["${backup_type}"]="OK (${file_size} bytes)"
  log "${backup_type}: verification PASSED (${file_size} bytes)"
}

# ── Run verifications ─────────────────────────────────────────────────────────

verify_one "pg-logical" "postgres/logical" ".enc"
verify_one "redis"      "redis"            ".rdb.enc"

# ── Check backup freshness ────────────────────────────────────────────────────

check_freshness() {
  local backup_type="$1" max_age_hours="$2"
  if [[ -z "${REDIS_URL:-}" ]]; then return; fi

  local last_ts
  last_ts="$(redis-cli -u "${REDIS_URL}" GET "velvet:backup:${backup_type}:last_ts" 2>/dev/null || echo "0")"
  local now
  now="$(date +%s)"
  local age_hours=$(( (now - ${last_ts:-0}) / 3600 ))

  if [[ ${age_hours} -gt ${max_age_hours} ]]; then
    warn "STALE: ${backup_type} last completed ${age_hours}h ago (threshold: ${max_age_hours}h)"
    CHECK_RESULTS["${backup_type}-freshness"]="STALE (${age_hours}h old)"
    OVERALL_STATUS="FAILED"
  else
    log "Freshness OK: ${backup_type} last backup ${age_hours}h ago"
  fi
}

check_freshness "pg-logical" 26   # should run daily — alert if older than 26h
check_freshness "redis"      14   # runs twice daily — alert if older than 14h
check_freshness "media"      7    # runs every 6h — alert if older than 7h

# ── Write verification report ─────────────────────────────────────────────────

REPORT="${WORK_DIR}/verify-report-${TIMESTAMP}.json"
{
  printf '{"timestamp":"%s","overall_status":"%s","checks":{' "${TIMESTAMP}" "${OVERALL_STATUS}"
  FIRST=1
  for key in "${!CHECK_RESULTS[@]}"; do
    [[ $FIRST -eq 0 ]] && printf ','
    printf '"%s":"%s"' "${key}" "${CHECK_RESULTS[$key]}"
    FIRST=0
  done
  printf '}}'
} > "${REPORT}"

aws s3 cp "${REPORT}" \
  "s3://${BACKUP_S3_BUCKET}/verify/verify-report-${TIMESTAMP}.json" \
  --content-type application/json --no-progress || true

# Update Redis with verification status
if [[ -n "${REDIS_URL:-}" ]]; then
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:verify:last_status" "${OVERALL_STATUS}" EX 90000 || true
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:verify:last_ts"     "$(date +%s)"       EX 90000 || true
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:verify:last_report" "$(cat "${REPORT}")" EX 90000 || true
fi

# ── Final result ──────────────────────────────────────────────────────────────

if [[ "${OVERALL_STATUS}" != "OK" ]]; then
  notify_failure "Backup verification FAILED. Results: $(cat "${REPORT}")"
  exit 1
fi

notify_success "All backup verifications PASSED. Timestamp: ${TIMESTAMP}"
