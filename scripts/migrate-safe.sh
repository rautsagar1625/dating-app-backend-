#!/usr/bin/env bash
# ── Safe Database Migration Script ───────────────────────────────────────────
#
# Usage:
#   ENVIRONMENT=staging  DATABASE_URL=postgresql://... bash scripts/migrate-safe.sh
#   ENVIRONMENT=production DATABASE_URL=postgresql://... bash scripts/migrate-safe.sh --dry-run
#
# Flags:
#   --dry-run    Preview the migration diff without applying it
#
# Environment vars:
#   DATABASE_URL     Required. PostgreSQL connection string.
#   ENVIRONMENT      Required. local | development | staging | production
#   GITHUB_ACTOR     Optional. User triggering the migration (for audit log).
#   CI               Set by GitHub Actions; disables interactive prompts.

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

# ── Validation ────────────────────────────────────────────────────────────────

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

if [[ -z "${ENVIRONMENT:-}" ]]; then
  echo "ERROR: ENVIRONMENT is not set (local|development|staging|production)" >&2
  exit 1
fi

OPERATOR="${GITHUB_ACTOR:-$(whoami)}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "═══════════════════════════════════════════════════════════"
echo " Velvet DB Migration"
echo " Environment : $ENVIRONMENT"
echo " Operator    : $OPERATOR"
echo " Timestamp   : $TIMESTAMP"
echo " Dry run     : $DRY_RUN"
echo "═══════════════════════════════════════════════════════════"

# ── Migration diff preview ────────────────────────────────────────────────────

echo ""
echo "── Migration diff ────────────────────────────────────────────────────────"
npx prisma migrate diff \
  --from-schema-datasource \
  --to-schema-datamodel \
  --script || true

# ── Destructive operation check ───────────────────────────────────────────────

echo ""
echo "── Checking for destructive operations ───────────────────────────────────"

LATEST_MIGRATION=$(ls prisma/migrations/ 2>/dev/null | sort | tail -1)
DESTRUCTIVE_FOUND=false

if [[ -n "$LATEST_MIGRATION" && -f "prisma/migrations/$LATEST_MIGRATION/migration.sql" ]]; then
  if grep -iE '(DROP TABLE|DROP COLUMN|TRUNCATE|ALTER TABLE.*DROP)' \
      "prisma/migrations/$LATEST_MIGRATION/migration.sql" > /dev/null 2>&1; then
    DESTRUCTIVE_FOUND=true
    echo "⚠️  WARNING: Destructive operations found in migration $LATEST_MIGRATION"
    grep -iE '(DROP TABLE|DROP COLUMN|TRUNCATE|ALTER TABLE.*DROP)' \
      "prisma/migrations/$LATEST_MIGRATION/migration.sql" || true
  else
    echo "✅ No destructive operations detected"
  fi
fi

# In production with destructive migrations, require explicit confirmation
if [[ "$DESTRUCTIVE_FOUND" == "true" && "$ENVIRONMENT" == "production" ]]; then
  if [[ "${CI:-false}" == "true" ]]; then
    echo "ERROR: Destructive migration detected in production CI run. Manual review required." >&2
    exit 1
  fi
  read -rp "Destructive migration in production. Type 'CONFIRM' to proceed: " confirmation
  [[ "$confirmation" != "CONFIRM" ]] && { echo "Aborted."; exit 1; }
fi

# ── Dry run exit ──────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "Dry run complete. No changes applied."
  exit 0
fi

# ── Apply migration ───────────────────────────────────────────────────────────

echo ""
echo "── Applying migrations ───────────────────────────────────────────────────"

SIGTERM_RECEIVED=false
trap 'SIGTERM_RECEIVED=true; echo "WARNING: Migration interrupted by SIGTERM at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"' SIGTERM

npx prisma migrate deploy

if [[ "$SIGTERM_RECEIVED" == "true" ]]; then
  echo "ERROR: Migration was interrupted. Check DB state manually." >&2
  exit 1
fi

echo "✅ Migrations applied successfully"

# ── Post-migration health check ───────────────────────────────────────────────

echo ""
echo "── Post-migration health check ───────────────────────────────────────────"

# Extract DB host for psql connectivity test
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|postgresql://[^@]+@([^:/]+).*|\1|')

npx prisma db execute --stdin <<'EOF'
SELECT 1 AS migration_health_check;
EOF
echo "✅ Database responsive post-migration"

# ── Audit log ─────────────────────────────────────────────────────────────────

echo ""
echo "── Writing audit log ─────────────────────────────────────────────────────"

GIT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo 'unknown')}"

npx prisma db execute --stdin <<EOF || echo "Audit log skipped (table may not exist yet)"
INSERT INTO "_migration_audit" (environment, operator, git_sha, applied_at)
VALUES ('$ENVIRONMENT', '$OPERATOR', '$GIT_SHA', NOW())
ON CONFLICT DO NOTHING;
EOF

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Migration complete ✅"
echo " SHA: $GIT_SHA"
echo "═══════════════════════════════════════════════════════════"
