#!/usr/bin/env bash
# PostgreSQL restore from a logical (pg_dump) backup.
# Downloads, decrypts, and restores to a target database.
#
# Usage:
#   ./pg-restore.sh --s3-key postgres/logical/velvet-pg-logical-20260512T030000Z.sql.gz.enc
#   ./pg-restore.sh --latest    # restore the most recent backup
#   ./pg-restore.sh --latest --target-db postgres://user:pass@host/newdb
#
# CAUTION: Restoring to RESTORE_DB_URL drops and recreates all objects.
# Set --dry-run to print the restore plan without executing.

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="pg-restore"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY

S3_KEY=""
TARGET_DB="${RESTORE_DB_URL:-${DATABASE_URL:-}}"
DRY_RUN=false

usage() {
  echo "Usage: $0 [--s3-key <key>] [--latest] [--target-db <url>] [--dry-run]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --s3-key)    S3_KEY="$2";    shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --latest)    S3_KEY="LATEST"; shift ;;
    --dry-run)   DRY_RUN=true;   shift ;;
    *) usage ;;
  esac
done

[[ -z "${S3_KEY}" ]] && usage
[[ -z "${TARGET_DB}" ]] && { error "No target DB URL. Set --target-db or RESTORE_DB_URL"; exit 1; }

setup_workdir

# ── Resolve --latest ──────────────────────────────────────────────────────────

if [[ "${S3_KEY}" == "LATEST" ]]; then
  log "Resolving latest pg-logical backup..."
  S3_KEY="$(aws s3 ls "s3://${BACKUP_S3_BUCKET}/postgres/logical/" \
    | grep '\.enc$' | sort | tail -1 | awk '{print $4}')"
  S3_KEY="postgres/logical/${S3_KEY}"
  log "Resolved: ${S3_KEY}"
fi

BASENAME="$(basename "${S3_KEY}")"
LOCAL_ENC="${WORK_DIR}/${BASENAME}"
LOCAL_DEC="${LOCAL_ENC%.enc}"

log "Restore plan:"
log "  Source:    s3://${BACKUP_S3_BUCKET}/${S3_KEY}"
log "  Target DB: $(echo "${TARGET_DB}" | sed 's|:.*@|:***@|')"
log "  Dry run:   ${DRY_RUN}"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "DRY RUN — no changes made."
  exit 0
fi

# ── Safety gate ───────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  WARNING: This will REPLACE all data in the target DB.  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
read -r -p "Type 'RESTORE' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "RESTORE" ]]; then
  log "Aborted by user."
  exit 1
fi

# ── Download ──────────────────────────────────────────────────────────────────

log "Downloading from S3..."
s3_download "${S3_KEY}" "${LOCAL_ENC}"

# ── Checksum ──────────────────────────────────────────────────────────────────

if aws s3 cp "s3://${BACKUP_S3_BUCKET}/${S3_KEY}.sha256" "${LOCAL_ENC}.sha256" --no-progress 2>/dev/null; then
  verify_checksum "${LOCAL_ENC}"
else
  warn "No checksum file found — proceeding without verification"
fi

# ── Decrypt ───────────────────────────────────────────────────────────────────

decrypt_file "${LOCAL_ENC}" "${LOCAL_DEC}"
rm -f "${LOCAL_ENC}"

# ── Restore ───────────────────────────────────────────────────────────────────

log "Starting pg_restore..."
pg_restore \
  --dbname="${TARGET_DB}" \
  --format=custom \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --verbose \
  "${LOCAL_DEC}" 2>&1 | while IFS= read -r line; do log "$line"; done

log "pg_restore complete."

# ── Smoke test ────────────────────────────────────────────────────────────────

log "Running smoke test queries..."
TABLE_COUNT="$(psql "${TARGET_DB}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
USER_COUNT="$(psql "${TARGET_DB}" -tAc 'SELECT count(*) FROM "User"')"
log "Smoke test: ${TABLE_COUNT} tables, ${USER_COUNT} users"

if [[ ${TABLE_COUNT} -lt 5 ]]; then
  error "Smoke test FAILED: only ${TABLE_COUNT} tables found (expected ≥5)"
  exit 1
fi

log "Restore and smoke test PASSED."
