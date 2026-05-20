#!/usr/bin/env bash
# Shared functions sourced by every backup script.
# Do NOT execute directly.

set -euo pipefail
IFS=$'\n\t'

# ── Structured logging ────────────────────────────────────────────────────────

log()   { printf '{"ts":"%s","level":"info","script":"%s","msg":"%s"}\n'  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-backup}" "$*"; }
warn()  { printf '{"ts":"%s","level":"warn","script":"%s","msg":"%s"}\n'  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-backup}" "$*"; }
error() { printf '{"ts":"%s","level":"error","script":"%s","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-backup}" "$*" >&2; }

# ── Environment validation ────────────────────────────────────────────────────

require_env() {
  local missing=0
  for var in "$@"; do
    if [[ -z "${!var:-}" ]]; then
      error "Required env var not set: $var"
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || exit 1
}

# ── Notifications ─────────────────────────────────────────────────────────────

notify_failure() {
  local msg="$1"
  error "BACKUP FAILED: $msg"
  if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    curl -s --max-time 10 -X POST "${SLACK_WEBHOOK_URL}" \
      -H 'Content-type: application/json' \
      --data "{\"text\":\":rotating_light: *[${VELVET_ENV:-prod}] Velvet Backup FAILED*\\n${msg}\"}" || true
  fi
  # Persist failure to Redis so the API health check can surface it
  if command -v redis-cli &>/dev/null && [[ -n "${REDIS_URL:-}" ]]; then
    redis-cli -u "${REDIS_URL}" SET "velvet:backup:${SCRIPT_NAME:-unknown}:last_status" "FAILED" EX 86400 || true
    redis-cli -u "${REDIS_URL}" SET "velvet:backup:${SCRIPT_NAME:-unknown}:last_error" "${msg}" EX 86400 || true
  fi
}

notify_success() {
  local msg="$1"
  log "BACKUP OK: $msg"
  if [[ -n "${SLACK_WEBHOOK_URL:-}" && "${NOTIFY_ON_SUCCESS:-false}" == "true" ]]; then
    curl -s --max-time 10 -X POST "${SLACK_WEBHOOK_URL}" \
      -H 'Content-type: application/json' \
      --data "{\"text\":\":white_check_mark: *[${VELVET_ENV:-prod}] Velvet Backup OK*\\n${msg}\"}" || true
  fi
}

# ── Encryption (AES-256-CBC, PBKDF2, 100k iterations) ─────────────────────────

encrypt_file() {
  local input="$1" output="$2"
  require_env BACKUP_ENCRYPTION_KEY
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
    -in "${input}" -out "${output}" \
    -pass "env:BACKUP_ENCRYPTION_KEY"
  log "Encrypted ${input} → ${output}"
}

decrypt_file() {
  local input="$1" output="$2"
  require_env BACKUP_ENCRYPTION_KEY
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
    -in "${input}" -out "${output}" \
    -pass "env:BACKUP_ENCRYPTION_KEY"
  log "Decrypted ${input} → ${output}"
}

# ── Checksums ─────────────────────────────────────────────────────────────────

write_checksum() {
  local file="$1"
  sha256sum "${file}" | awk '{print $1}' > "${file}.sha256"
  log "Checksum written: $(cat "${file}.sha256") ${file}"
}

verify_checksum() {
  local file="$1"
  local expected
  expected="$(cat "${file}.sha256")"
  local actual
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [[ "${expected}" != "${actual}" ]]; then
    error "Checksum mismatch for ${file}: expected=${expected} actual=${actual}"
    return 1
  fi
  log "Checksum verified: ${file}"
}

# ── S3 helpers ────────────────────────────────────────────────────────────────

s3_upload() {
  local local_path="$1" s3_key="$2"
  require_env BACKUP_S3_BUCKET
  local s3_uri="s3://${BACKUP_S3_BUCKET}/${s3_key}"
  log "Uploading ${local_path} → ${s3_uri}"
  aws s3 cp "${local_path}" "${s3_uri}" \
    --sse aws:kms \
    ${BACKUP_KMS_KEY_ID:+--sse-kms-key-id "${BACKUP_KMS_KEY_ID}"} \
    --storage-class "${BACKUP_S3_STORAGE_CLASS:-STANDARD_IA}" \
    --no-progress
  # Also upload the checksum file if it exists
  if [[ -f "${local_path}.sha256" ]]; then
    aws s3 cp "${local_path}.sha256" "${s3_uri}.sha256" \
      --sse aws:kms \
      ${BACKUP_KMS_KEY_ID:+--sse-kms-key-id "${BACKUP_KMS_KEY_ID}"} \
      --storage-class STANDARD \
      --no-progress
  fi
  log "Upload complete: ${s3_uri}"
}

s3_download() {
  local s3_key="$1" local_path="$2"
  require_env BACKUP_S3_BUCKET
  aws s3 cp "s3://${BACKUP_S3_BUCKET}/${s3_key}" "${local_path}" --no-progress
}

s3_list() {
  local prefix="$1"
  aws s3 ls "s3://${BACKUP_S3_BUCKET}/${prefix}" --recursive | awk '{print $4}' | sort
}

# ── Redis backup status writer ────────────────────────────────────────────────

record_backup_success() {
  local backup_type="$1" size_bytes="$2" s3_key="$3"
  if [[ -z "${REDIS_URL:-}" ]]; then return; fi
  local payload
  payload="{\"status\":\"OK\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"size\":${size_bytes},\"key\":\"${s3_key}\"}"
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:${backup_type}:last_status"  "OK"           EX 90000 || true
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:${backup_type}:last_success" "${payload}"   EX 90000 || true
  redis-cli -u "${REDIS_URL}" SET "velvet:backup:${backup_type}:last_ts"      "$(date +%s)"  EX 90000 || true
}

# ── Temp dir management ───────────────────────────────────────────────────────

WORK_DIR=""
setup_workdir() {
  WORK_DIR="$(mktemp -d /tmp/velvet-backup-XXXXXX)"
  log "Working directory: ${WORK_DIR}"
  # Always clean up, even on failure
  trap 'rm -rf "${WORK_DIR}"' EXIT
}
