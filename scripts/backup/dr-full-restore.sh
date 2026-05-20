#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  VELVET DISASTER RECOVERY — FULL RESTORE PLAYBOOK                       ║
# ║  Execute during declared disaster only.                                  ║
# ║  Incident commander must approve before running.                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# Restores the complete stack from S3 backups:
#   1. PostgreSQL (logical backup or WAL-G PITR)
#   2. Redis (RDB snapshot)
#   3. Media files (S3 sync from backup bucket)
#
# Usage:
#   ./dr-full-restore.sh [--pitr "2026-05-12 14:00:00 UTC"] [--dry-run]
#
# Required env: DATABASE_URL, BACKUP_S3_BUCKET, BACKUP_ENCRYPTION_KEY,
#               REDIS_URL, MEDIA_LOCAL_PATH, MEDIA_S3_BUCKET

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="dr-playbook"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY

DRY_RUN=false
PITR_TARGET=""
INCIDENT_ID="${INCIDENT_ID:-IR-$(date -u +%Y%m%d-%H%M%S)}"
DR_LOG="/var/log/velvet-dr-${INCIDENT_ID}.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --pitr)    PITR_TARGET="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

exec > >(tee -a "${DR_LOG}") 2>&1

log "══════════════════════════════════════════════════════"
log "  DISASTER RECOVERY INITIATED"
log "  Incident ID:  ${INCIDENT_ID}"
log "  Timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "  PITR target:  ${PITR_TARGET:-LATEST}"
log "  Dry run:      ${DRY_RUN}"
log "══════════════════════════════════════════════════════"

if [[ "${DRY_RUN}" != "true" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  DISASTER RECOVERY PLAYBOOK — ALL DATA WILL BE REPLACED     ║"
  echo "║  This restores production from S3 backups.                  ║"
  echo "║  Ensure all app instances are stopped before continuing.    ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Pre-flight checklist:"
  echo "  [ ] Application pods are scaled to 0"
  echo "  [ ] No active database connections"
  echo "  [ ] Incident commander has approved this action"
  echo "  [ ] Backup S3 bucket is accessible"
  echo "  [ ] Recovery target time confirmed: ${PITR_TARGET:-LATEST}"
  echo ""
  read -r -p "Type incident ID '${INCIDENT_ID}' to confirm and proceed: " CONFIRM
  if [[ "${CONFIRM}" != "${INCIDENT_ID}" ]]; then
    log "Aborted by operator — confirmation mismatch."
    exit 1
  fi
fi

DR_START="$(date +%s)"
setup_workdir

step() {
  local n="$1" desc="$2"
  log ""
  log "━━━ STEP ${n}: ${desc} ━━━"
}

# ════════════════════════════════════════════════════════════════════════════
# STEP 1: PostgreSQL restore
# ════════════════════════════════════════════════════════════════════════════

step 1 "PostgreSQL restore"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would restore PostgreSQL from latest backup"
else
  if [[ -n "${WALG_S3_PREFIX:-}" ]]; then
    log "Using WAL-G PITR restore (preferred)"
    BACKUP_NAME="LATEST"
    WALG_RESTORE_ARGS="--pgdata ${PGDATA:-/var/lib/postgresql/data} --backup-name ${BACKUP_NAME}"
    [[ -n "${PITR_TARGET}" ]] && WALG_RESTORE_ARGS="${WALG_RESTORE_ARGS} --target-time '${PITR_TARGET}'"
    bash "${SCRIPT_DIR}/pg-walg-pitr-restore.sh" ${WALG_RESTORE_ARGS} <<< "${INCIDENT_ID}"
  else
    log "WAL-G not configured — falling back to logical restore"
    bash "${SCRIPT_DIR}/pg-restore.sh" --latest --target-db "${DATABASE_URL}" <<< "RESTORE"
  fi
  log "Step 1 COMPLETE: PostgreSQL restored"
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 2: Redis restore
# ════════════════════════════════════════════════════════════════════════════

step 2 "Redis restore"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would restore Redis from latest RDB backup"
else
  require_env REDIS_URL

  LATEST_REDIS="$(aws s3 ls "s3://${BACKUP_S3_BUCKET}/redis/" \
    | grep '\.rdb\.enc$' | sort | tail -1 | awk '{print $4}')"

  if [[ -z "${LATEST_REDIS}" ]]; then
    warn "No Redis RDB backup found — Redis will start empty (queues will be empty, this is recoverable)"
  else
    S3_REDIS_KEY="redis/${LATEST_REDIS}"
    LOCAL_REDIS_ENC="${WORK_DIR}/${LATEST_REDIS}"
    LOCAL_REDIS_DEC="${LOCAL_REDIS_ENC%.enc}"

    log "Downloading Redis backup: ${S3_REDIS_KEY}"
    aws s3 cp "s3://${BACKUP_S3_BUCKET}/${S3_REDIS_KEY}" "${LOCAL_REDIS_ENC}" --no-progress
    decrypt_file "${LOCAL_REDIS_ENC}" "${LOCAL_REDIS_DEC}"

    # Copy RDB to Redis data directory
    RDB_PATH="${REDIS_RDB_PATH:-/data/dump.rdb}"
    log "Installing RDB to ${RDB_PATH}"
    cp "${LOCAL_REDIS_DEC}" "${RDB_PATH}"
    chown redis:redis "${RDB_PATH}" 2>/dev/null || true

    log "Step 2 COMPLETE: Redis RDB restored to ${RDB_PATH}. Restart Redis to load."
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 3: Media files restore
# ════════════════════════════════════════════════════════════════════════════

step 3 "Media files restore"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would sync media from s3://${BACKUP_S3_BUCKET}/media/uploads"
else
  MEDIA_PATH="${MEDIA_LOCAL_PATH:-/app/uploads}"
  mkdir -p "${MEDIA_PATH}"

  log "Syncing media from s3://${BACKUP_S3_BUCKET}/media/uploads → ${MEDIA_PATH}"
  aws s3 sync "s3://${BACKUP_S3_BUCKET}/media/uploads" "${MEDIA_PATH}" \
    --no-progress --only-show-errors

  RESTORED_FILES="$(find "${MEDIA_PATH}" -type f | wc -l | tr -d ' ')"
  log "Step 3 COMPLETE: ${RESTORED_FILES} media files restored"
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 4: Run Prisma migrations (apply any pending)
# ════════════════════════════════════════════════════════════════════════════

step 4 "Database migration check"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would run: npx prisma migrate deploy"
else
  if command -v npx &>/dev/null && [[ -f "/app/prisma/schema.prisma" ]]; then
    log "Applying any pending Prisma migrations..."
    cd /app && npx prisma migrate deploy 2>&1 | while IFS= read -r line; do log "$line"; done
    log "Step 4 COMPLETE: Migrations applied"
  else
    warn "Prisma not found at /app — skip migration step (run manually if needed)"
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 5: Smoke test
# ════════════════════════════════════════════════════════════════════════════

step 5 "Post-restore smoke test"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would run smoke tests"
else
  if [[ -n "${DATABASE_URL:-}" ]]; then
    TABLE_COUNT="$(psql "${DATABASE_URL}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")"
    log "Database tables: ${TABLE_COUNT}"
    [[ "${TABLE_COUNT}" -lt 10 ]] && { error "Smoke test FAILED: only ${TABLE_COUNT} tables"; exit 1; }

    USER_COUNT="$(psql "${DATABASE_URL}" -tAc 'SELECT count(*) FROM "User"' 2>/dev/null || echo "0")"
    log "User count: ${USER_COUNT}"

    log "Step 5 COMPLETE: Smoke test passed"
  else
    warn "DATABASE_URL not set — skipping smoke test"
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════════════

DR_DURATION=$(( $(date +%s) - DR_START ))

log ""
log "══════════════════════════════════════════════════════"
log "  DISASTER RECOVERY COMPLETE"
log "  Incident ID:   ${INCIDENT_ID}"
log "  Total time:    ${DR_DURATION}s ($((DR_DURATION / 60))m $((DR_DURATION % 60))s)"
log "  DR log:        ${DR_LOG}"
log ""
log "  NEXT STEPS:"
log "  1. Start PostgreSQL (if PITR was used, wait for promotion)"
log "  2. Start Redis"
log "  3. Scale up application pods"
log "  4. Monitor /health endpoint"
log "  5. Update incident runbook with actual recovery time"
log "══════════════════════════════════════════════════════"

notify_success "DR COMPLETE for incident ${INCIDENT_ID}. Total recovery time: ${DR_DURATION}s"
