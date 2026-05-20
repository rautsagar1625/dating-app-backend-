# Runbook: Rollback Procedures

---

## API Rollback

```bash
# View deployment history
kubectl rollout history deployment/velvet-api -n velvet

# Roll back one version
kubectl rollout undo deployment/velvet-api -n velvet

# Roll back to specific revision
kubectl rollout undo deployment/velvet-api -n velvet --to-revision=<N>

# Watch rollout
kubectl rollout status deployment/velvet-api -n velvet --timeout=5m

# Verify
kubectl get pods -n velvet -l app=velvet-api
curl -sf https://api.velvet.app/live && echo "OK"
```

---

## Worker Rollback

```bash
kubectl rollout undo deployment/velvet-workers -n velvet
kubectl rollout status deployment/velvet-workers -n velvet --timeout=5m
```

---

## Database Migration Rollback

**Important**: Prisma does not support automatic down-migrations. This is a manual procedure.

### Before any production migration (pre-flight):
```bash
# Take a logical backup (schema + data)
pg_dump $DATABASE_URL --no-acl --no-owner -f "backup_$(date +%Y%m%d_%H%M%S).sql"
```

### When a migration must be reversed:
1. Identify the migration: `npx prisma migrate status`
2. Write a reversal SQL script (`migrations/revert_XXXXX.sql`) — manually reverse the DDL
3. Apply via psql:
   ```bash
   psql $DATABASE_URL < migrations/revert_XXXXX.sql
   ```
4. Mark migration as reverted in Prisma's tracking table:
   ```sql
   UPDATE "_prisma_migrations"
   SET rolled_back_at = NOW()
   WHERE migration_name = '20240101000000_your_migration_name';
   ```
5. Rollback the application code (API rollback above)

**Warning**: If the migration added columns that new code writes to, rolling back the migration while the new code is live will cause errors. Always roll back the API first, then the migration.

---

## Feature Flag Rollback (fastest — no deploy needed)

```bash
# Via admin API
curl -X PATCH https://api.velvet.app/admin/flags/NEW_RECOMMENDATION_ALGO \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Via LaunchDarkly dashboard: toggle the flag off for 100% of users instantly
```

Feature flag rollback takes effect within seconds — no deployment required.

---

## Config/Secret Rollback

Kubernetes secrets don't support rollout undo. Manually revert:

```bash
# Get current value (base64 encoded)
kubectl get secret velvet-api-secrets -n velvet -o yaml

# Patch a specific key back to its previous value
kubectl patch secret velvet-api-secrets -n velvet \
  --type='json' \
  -p='[{"op":"replace","path":"/data/SOME_KEY","value":"'$(echo -n "previous_value" | base64)'"}]'

# Rolling restart to pick up new secret values
kubectl rollout restart deployment/velvet-api -n velvet
```

---

## Rollback Decision Matrix

| Scenario | Fastest Rollback | Risk |
|----------|-----------------|------|
| Bad deploy (code) | `kubectl rollout undo` | Low |
| Feature causing issues | Disable feature flag | Minimal |
| DB migration broke app | API rollback → SQL reversal | High — needs pre-migration backup |
| Bad config/secret | Patch secret + rolling restart | Low |
| Provider credential rotated | Update secret + rolling restart | Low |
