#!/usr/bin/env bash
# PostgreSQL logical backup via pg_dump.
# Produces a compressed, encrypted, checksummed dump uploaded to S3.
# Runs daily (full) — also used as a portable restore source independent of WAL-G.
#
# Required env: DATABASE_URL, BACKUP_S3_BUCKET, BACKUP_ENCRYPTION_KEY
# Optional env:  BACKUP_KMS_KEY_ID, SLACK_WEBHOOK_URL, REDIS_URL, NOTIFY_ON_SUCCESS
#
# Exit codes: 0 = success, 1 = failure (K8s CronJob marks pod as Failed on non-zero)

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="pg-logical"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env DATABASE_URL BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY

setup_workdir

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="velvet-pg-logical-${TIMESTAMP}.sql.gz"
ENCRYPTED="${FILENAME}.enc"
LOCAL_FILE="${WORK_DIR}/${FILENAME}"
LOCAL_ENC="${WORK_DIR}/${ENCRYPTED}"
S3_KEY="postgres/logical/${ENCRYPTED}"

log "Starting PostgreSQL logical backup: ${TIMESTAMP}"

# ── 1. Dump ───────────────────────────────────────────────────────────────────

log "Running pg_dump..."
pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-password \
  --verbose \
  --file="${LOCAL_FILE}" 2>&1 | while IFS= read -r line; do log "$line"; done

DUMP_SIZE="$(stat -c%s "${LOCAL_FILE}" 2>/dev/null || stat -f%z "${LOCAL_FILE}")"
log "Dump complete. Size: ${DUMP_SIZE} bytes"

# ── 2. Encrypt ────────────────────────────────────────────────────────────────

encrypt_file "${LOCAL_FILE}" "${LOCAL_ENC}"
rm -f "${LOCAL_FILE}"  # remove plaintext immediately

# ── 3. Checksum ───────────────────────────────────────────────────────────────

write_checksum "${LOCAL_ENC}"

# ── 4. Upload ─────────────────────────────────────────────────────────────────

if ! s3_upload "${LOCAL_ENC}" "${S3_KEY}"; then
  notify_failure "S3 upload failed for ${S3_KEY}"
  exit 1
fi

# ── 5. Write manifest to S3 ───────────────────────────────────────────────────

MANIFEST_KEY="postgres/logical/manifest-${TIMESTAMP}.json"
cat > "${WORK_DIR}/manifest.json" <<EOF
{
  "type": "pg-logical",
  "timestamp": "${TIMESTAMP}",
  "s3_key": "${S3_KEY}",
  "size_bytes": ${DUMP_SIZE},
  "encrypted": true,
  "encryption": "aes-256-cbc-pbkdf2",
  "checksum_sha256": "$(cat "${LOCAL_ENC}.sha256")",
  "pg_dump_format": "custom",
  "compression": "gzip-9"
}
EOF
aws s3 cp "${WORK_DIR}/manifest.json" \
  "s3://${BACKUP_S3_BUCKET}/${MANIFEST_KEY}" \
  --content-type application/json \
  --no-progress

# ── 6. Record success in Redis ────────────────────────────────────────────────

record_backup_success "pg-logical" "${DUMP_SIZE}" "${S3_KEY}"
notify_success "pg-logical backup complete. Size: ${DUMP_SIZE} bytes. Key: ${S3_KEY}"
