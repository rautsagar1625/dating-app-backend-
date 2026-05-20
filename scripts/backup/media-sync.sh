#!/usr/bin/env bash
# Media backup: syncs the uploads/ directory to S3 with server-side encryption.
# Runs every 6 hours (incremental — only changed/new files are uploaded).
# S3 bucket should have versioning + CRR enabled at the infrastructure level.
#
# Required env: BACKUP_S3_BUCKET, MEDIA_LOCAL_PATH
# Optional env:  BACKUP_KMS_KEY_ID, SLACK_WEBHOOK_URL, REDIS_URL

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="media"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env BACKUP_S3_BUCKET

MEDIA_PATH="${MEDIA_LOCAL_PATH:-/app/uploads}"
S3_PREFIX="media/uploads"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log "Starting media sync: ${MEDIA_PATH} → s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}"

if [[ ! -d "${MEDIA_PATH}" ]]; then
  warn "Media directory not found at ${MEDIA_PATH} — skipping sync"
  exit 0
fi

# ── Count files before sync ───────────────────────────────────────────────────

FILE_COUNT="$(find "${MEDIA_PATH}" -type f | wc -l | tr -d ' ')"
TOTAL_SIZE="$(du -sb "${MEDIA_PATH}" | awk '{print $1}')"
log "Local media: ${FILE_COUNT} files, ${TOTAL_SIZE} bytes"

# ── Incremental sync ──────────────────────────────────────────────────────────
# --size-only: skip re-upload if size matches (avoids re-uploading identical files)
# --sse: server-side encryption for every object
# --delete: remove objects from S3 that no longer exist locally
#           (only enable if S3 versioning is on, so deletes are recoverable)

SSE_ARGS="--sse aws:kms"
if [[ -n "${BACKUP_KMS_KEY_ID:-}" ]]; then
  SSE_ARGS="${SSE_ARGS} --sse-kms-key-id ${BACKUP_KMS_KEY_ID}"
fi

SYNC_OUTPUT="$(aws s3 sync "${MEDIA_PATH}" "s3://${BACKUP_S3_BUCKET}/${S3_PREFIX}" \
  ${SSE_ARGS} \
  --storage-class "${MEDIA_S3_STORAGE_CLASS:-STANDARD}" \
  --no-progress \
  --only-show-errors 2>&1)"

UPLOADED="$(echo "${SYNC_OUTPUT}" | grep -c 'upload:' || true)"
log "Sync complete. Files uploaded/updated: ${UPLOADED}"

# ── Write sync manifest ───────────────────────────────────────────────────────

MANIFEST_KEY="media/manifests/sync-${TIMESTAMP}.json"
MANIFEST="$(mktemp)"
cat > "${MANIFEST}" <<EOF
{
  "type": "media-sync",
  "timestamp": "${TIMESTAMP}",
  "local_path": "${MEDIA_PATH}",
  "s3_prefix": "${S3_PREFIX}",
  "total_local_files": ${FILE_COUNT},
  "total_local_bytes": ${TOTAL_SIZE},
  "files_uploaded": ${UPLOADED}
}
EOF

aws s3 cp "${MANIFEST}" "s3://${BACKUP_S3_BUCKET}/${MANIFEST_KEY}" \
  --content-type application/json --no-progress || true
rm -f "${MANIFEST}"

# ── Record success ────────────────────────────────────────────────────────────

record_backup_success "media" "${TOTAL_SIZE}" "${S3_PREFIX}"
notify_success "Media sync complete. ${FILE_COUNT} files (${TOTAL_SIZE} bytes), ${UPLOADED} uploaded to S3."
