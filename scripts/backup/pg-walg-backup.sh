#!/usr/bin/env bash
# PostgreSQL continuous backup via WAL-G.
# Pushes a base backup to S3. Combined with WAL archiving (archive_command),
# this enables point-in-time recovery to any second.
#
# WAL archiving is configured in postgresql.conf (see pg-wal-setup.conf).
# This script handles scheduled base backups (run daily, independent of WAL push).
#
# Required env: WALG_S3_PREFIX, AWS creds, WALG_LIBSODIUM_KEY or WALG_GPG_KEY_ID
# Optional env:  SLACK_WEBHOOK_URL, REDIS_URL

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="pg-walg"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env WALG_S3_PREFIX

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
log "Starting WAL-G base backup: ${TIMESTAMP}"

# ── Base backup push ──────────────────────────────────────────────────────────
# WAL-G handles compression, encryption, and upload internally using its env config.

if ! wal-g backup-push "${PGDATA:-/var/lib/postgresql/data}" 2>&1 \
    | while IFS= read -r line; do log "$line"; done; then
  notify_failure "wal-g backup-push failed"
  exit 1
fi

# ── Verify the backup was registered ─────────────────────────────────────────

log "Verifying backup was listed in WAL-G catalog..."
LATEST="$(wal-g backup-list --detail 2>&1 | tail -1)"
log "Latest backup entry: ${LATEST}"

if [[ -z "${LATEST}" ]]; then
  notify_failure "wal-g backup-list returned empty after push"
  exit 1
fi

# ── Delete old base backups (retain per WAL-G policy) ─────────────────────────
# WAL-G retains the last N full backups and their WAL. Adjust WALG_RETAIN_FULL_BACKUPS
# in env to control (default: 7 base backups = ~7 days of PITR).

RETAIN="${WALG_RETAIN_FULL_BACKUPS:-7}"
log "Applying retention: keeping last ${RETAIN} base backups..."
wal-g delete retain FULL "${RETAIN}" --confirm 2>&1 | while IFS= read -r line; do log "$line"; done || true

record_backup_success "pg-walg" "0" "${WALG_S3_PREFIX}"
notify_success "WAL-G base backup complete. Latest: ${LATEST}"
