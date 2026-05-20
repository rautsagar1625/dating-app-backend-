#!/usr/bin/env bash
# Point-in-time recovery (PITR) using WAL-G.
# Restores a base backup and replays WAL segments up to a target timestamp.
#
# Usage:
#   # Restore to latest (full recovery)
#   ./pg-walg-pitr-restore.sh --pgdata /var/lib/postgresql/data
#
#   # Restore to a specific point in time
#   ./pg-walg-pitr-restore.sh --pgdata /var/lib/postgresql/data --target-time "2026-05-12 14:00:00 UTC"
#
#   # Restore a specific base backup
#   ./pg-walg-pitr-restore.sh --pgdata /var/lib/postgresql/data --backup-name LATEST
#
# IMPORTANT: Stop PostgreSQL before running this script.
# The PGDATA directory will be REPLACED.

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="pg-pitr"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_env WALG_S3_PREFIX

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
BACKUP_NAME="LATEST"
TARGET_TIME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pgdata)       PGDATA="$2";       shift 2 ;;
    --backup-name)  BACKUP_NAME="$2";  shift 2 ;;
    --target-time)  TARGET_TIME="$2";  shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

log "PITR restore plan:"
log "  PGDATA:       ${PGDATA}"
log "  Base backup:  ${BACKUP_NAME}"
log "  Target time:  ${TARGET_TIME:-latest (full recovery)}"
log "  WAL prefix:   ${WALG_S3_PREFIX}"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  WARNING: PGDATA directory will be REPLACED.            ║"
echo "║  Ensure PostgreSQL is STOPPED before proceeding.        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
read -r -p "Type 'PITR' to confirm: " CONFIRM
[[ "${CONFIRM}" == "PITR" ]] || { log "Aborted."; exit 1; }

# ── 1. Fetch base backup ──────────────────────────────────────────────────────

log "Fetching base backup ${BACKUP_NAME} into ${PGDATA}..."
wal-g backup-fetch "${PGDATA}" "${BACKUP_NAME}" 2>&1 | while IFS= read -r line; do log "$line"; done

# ── 2. Write recovery configuration ──────────────────────────────────────────
# PostgreSQL 12+: recovery settings go in postgresql.auto.conf, signal via recovery.signal

cat > "${PGDATA}/postgresql.auto.conf" <<PGCONF
restore_command = 'wal-g wal-fetch "%f" "%p"'
recovery_target_action = 'promote'
${TARGET_TIME:+recovery_target_time = '${TARGET_TIME}'}
${TARGET_TIME:+recovery_target_inclusive = true}
PGCONF

# PostgreSQL 12+ uses a signal file instead of recovery.conf
touch "${PGDATA}/recovery.signal"

log "Recovery configuration written to ${PGDATA}/postgresql.auto.conf"
log "Created recovery.signal — PostgreSQL will enter recovery mode on next start."

# ── 3. Fix permissions ────────────────────────────────────────────────────────

chown -R postgres:postgres "${PGDATA}" 2>/dev/null || true
chmod 700 "${PGDATA}"

log "Restore ready. Start PostgreSQL to begin WAL replay."
log "Monitor progress: tail -f /var/log/postgresql/postgresql.log"
log "Recovery is complete when 'database system is ready to accept connections' appears."
