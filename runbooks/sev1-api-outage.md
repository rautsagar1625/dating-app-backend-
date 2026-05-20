# SEV-1 Runbook: API Outage

**Trigger**: API error rate > 20%, or all API pods down, or health endpoint unreachable.

**Alert**: `APIVeryHighErrorRate` or `APIDown` in Grafana/PagerDuty.

---

## Step 1: Triage (first 5 minutes)

**Declare IC.** Post in #incidents: `🔴 SEV-1 declared. IC: @[you]. Investigating API outage.`

### Check pod status
```bash
kubectl get pods -n velvet -l app=velvet-api
# Expected: 3/3 Running. Any CrashLoopBackOff, OOMKilled, Error → note it.

kubectl describe pod -n velvet -l app=velvet-api
# Look for: Events section — OOMKilled, failed readiness probe, image pull error
```

### Check recent deployments
```bash
kubectl rollout history deployment/velvet-api -n velvet
# If a deployment happened in the last 30 min → likely cause
```

### Check logs
```bash
kubectl logs -n velvet -l app=velvet-api --tail=200 --timestamps
# Look for: startup errors, uncaught exceptions, DB connection errors
```

### Check Sentry
Go to: `https://sentry.io/organizations/velvet/issues/?project=backend&query=is%3Aunresolved`
- Filter: last 30 min
- Sort by: frequency
- Look for: new error groups that spiked

---

## Step 2: Decision Tree

### OOMKilled pods
```bash
kubectl describe pod <pod-name> -n velvet | grep -A5 'Last State'
# If OOMKilled: container exceeded memory limit
```
→ If recent deploy: **rollback** (Step 3)
→ If not recent deploy: increase memory limit temporarily:
```bash
kubectl set resources deployment/velvet-api -n velvet --limits=memory=4Gi
```

### CrashLoopBackOff
```bash
kubectl logs -n velvet <pod-name> --previous
# Shows logs from the crashed container
```
→ Check for: missing env vars, DB connection refused, bad config
→ If missing env: check secret exists: `kubectl get secret velvet-api-secrets -n velvet`
→ If bad config: **rollback** (Step 3)

### All pods healthy but requests failing
```bash
# Check if it's a dependency issue
kubectl exec -n velvet deployment/velvet-api -- curl -s http://localhost:3002/ready
# /ready checks DB + Redis — if it returns {"status":"degraded"}, a dependency is down
```
→ DB issue → see [db-failover.md](./db-failover.md)
→ Redis issue → see [redis-incident.md](./redis-incident.md)

### Image pull failure
```bash
kubectl describe pod <pod-name> -n velvet | grep -A5 'Failed'
# "ImagePullBackOff" → authentication or network issue to GHCR
kubectl get secret ghcr-pull-secret -n velvet  # verify secret exists
```

---

## Step 3: Rollback Procedure

```bash
# List deployment history
kubectl rollout history deployment/velvet-api -n velvet

# Roll back to previous revision
kubectl rollout undo deployment/velvet-api -n velvet

# Or roll back to specific revision:
kubectl rollout undo deployment/velvet-api -n velvet --to-revision=<N>

# Watch rollout progress
kubectl rollout status deployment/velvet-api -n velvet --timeout=5m

# Verify pods are healthy
kubectl get pods -n velvet -l app=velvet-api
kubectl logs -n velvet -l app=velvet-api --tail=50
```

**Smoke test after rollback:**
```bash
curl -sf https://api.velvet.app/live
curl -sf https://api.velvet.app/ready
```

---

## Step 4: Communication

**While investigating** (every 10 min):
```
🔴 SEV-1 Update [HH:MM UTC]: Still investigating. [Current theory]. Next update in 10 min.
```

**After rollback / fix applied**:
```
🟡 SEV-1 Update [HH:MM UTC]: Fix applied (rollback to revision N). Monitoring recovery. Next update in 5 min.
```

**Resolution**:
```
✅ SEV-1 RESOLVED [HH:MM UTC]. API restored. Duration: X min. Root cause: [summary]. Post-mortem within 48h.
```

Update status page: https://status.velvet.app

---

## Step 5: Post-Incident (blameless)

Within 48 hours, fill out:
- **What happened?** (timeline)
- **Why did it happen?** (root cause — system, not person)
- **What did we do to fix it?**
- **What would have caught this earlier?**
- **Action items** (with owners and due dates)
