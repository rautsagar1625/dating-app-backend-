#!/usr/bin/env bash
# Backup retention policy enforcement.
# Deletes S3 objects older than the configured retention windows.
# Runs weekly via cron/K8s CronJob.
#
# Retention policy:
#   postgres/logical/  → 7 daily + 4 weekly + 12 monthly
#   redis/             → 7 daily
#   media/manifests/   → 30 days
#   verify/            → 30 days
#
# Required env: BACKUP_S3_BUCKET
# Optional env:  SLACK_WEBHOOK_URL

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="retention"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env BACKUP_S3_BUCKET

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TOTAL_DELETED=0

log "Starting retention cleanup: ${TIMESTAMP}"

# ── Delete S3 objects older than N days ───────────────────────────────────────

delete_older_than_days() {
  local prefix="$1" days="$2"
  local cutoff_epoch
  cutoff_epoch="$(date -d "${days} days ago" +%s 2>/dev/null || date -v-${days}d +%s)"
  local deleted=0

  log "Cleaning ${prefix}: objects older than ${days} days (before $(date -d "@${cutoff_epoch}" -u +%Y-%m-%d 2>/dev/null || date -r "${cutoff_epoch}" -u +%Y-%m-%d))"

  # List all objects, filter by age, delete in batches
  while IFS= read -r object_key; do
    [[ -z "${object_key}" ]] && continue
    # Get object's last modified date
    local obj_date
    obj_date="$(aws s3api head-object \
      --bucket "${BACKUP_S3_BUCKET}" \
      --key "${object_key}" \
      --query LastModified \
      --output text 2>/dev/null || echo "")"

    if [[ -z "${obj_date}" ]]; then continue; fi

    local obj_epoch
    obj_epoch="$(date -d "${obj_date}" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${obj_date:0:19}" +%s 2>/dev/null || echo "0")"

    if [[ ${obj_epoch} -lt ${cutoff_epoch} ]]; then
      aws s3 rm "s3://${BACKUP_S3_BUCKET}/${object_key}" --quiet
      log "Deleted: ${object_key}"
      deleted=$((deleted + 1))
      TOTAL_DELETED=$((TOTAL_DELETED + 1))
    fi
  done < <(s3_list "${prefix}" | grep -v '/$' || true)

  log "Cleaned ${prefix}: ${deleted} objects deleted"
}

# ── Implement grandfather-father-son retention ────────────────────────────────
# For pg-logical: keep all dailies ≤7d, all Sundays ≤28d, all 1sts ≤365d

retain_gfs() {
  local prefix="$1"
  local now_epoch
  now_epoch="$(date +%s)"

  log "GFS retention for ${prefix}"
  local deleted=0

  while IFS= read -r object_key; do
    [[ -z "${object_key}" ]] && continue
    [[ "${object_key}" == *.sha256 ]] && continue   # never delete checksums before parent
    [[ "${object_key}" == *manifest* ]] && continue # manifests are tiny, keep them

    local obj_date
    obj_date="$(aws s3api head-object \
      --bucket "${BACKUP_S3_BUCKET}" --key "${object_key}" \
      --query LastModified --output text 2>/dev/null || echo "")"
    [[ -z "${obj_date}" ]] && continue

    local obj_epoch
    obj_epoch="$(date -d "${obj_date}" +%s 2>/dev/null || echo "0")"
    local age_days=$(( (now_epoch - obj_epoch) / 86400 ))

    # Always keep last 7 days
    if [[ ${age_days} -le 7 ]]; then continue; fi

    local obj_dow obj_dom
    obj_dow="$(date -d "${obj_date}" +%u 2>/dev/null || date -j -f "%Y-%m-%d" "${obj_date:0:10}" +%u 2>/dev/null || echo "0")"
    obj_dom="$(date -d "${obj_date}" +%d 2>/dev/null || date -j -f "%Y-%m-%d" "${obj_date:0:10}" +%d 2>/dev/null || echo "01")"

    # Keep Sundays (dow=7) for last 4 weeks (8-28 days old)
    if [[ ${age_days} -le 28 && "${obj_dow}" == "7" ]]; then continue; fi

    # Keep 1st of month for last 12 months (29-365 days old)
    if [[ ${age_days} -le 365 && "${obj_dom}" == "01" ]]; then continue; fi

    # Delete everything else
    aws s3 rm "s3://${BACKUP_S3_BUCKET}/${object_key}" --quiet
    # Also delete its checksum
    aws s3 rm "s3://${BACKUP_S3_BUCKET}/${object_key}.sha256" --quiet 2>/dev/null || true
    log "GFS deleted (${age_days}d old): ${object_key}"
    deleted=$((deleted + 1))
    TOTAL_DELETED=$((TOTAL_DELETED + 1))
  done < <(s3_list "${prefix}" | grep -v '/$' || true)

  log "GFS cleanup ${prefix}: ${deleted} objects deleted"
}

# ── Apply policies ────────────────────────────────────────────────────────────

retain_gfs         "postgres/logical"   # daily-7 + weekly-4 + monthly-12
delete_older_than_days "redis"    7     # 7-day rolling window for Redis RDB
delete_older_than_days "media/manifests" 30  # manifest logs kept 30 days
delete_older_than_days "verify"   30    # verification reports kept 30 days

log "Retention cleanup complete. Total objects deleted: ${TOTAL_DELETED}"
notify_success "Retention cleanup complete. Deleted ${TOTAL_DELETED} objects."
