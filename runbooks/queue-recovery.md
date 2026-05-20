# Runbook: BullMQ Queue Recovery

**Trigger**: `QueueWorkersStopped` or `QueueDepthCritical` alert. Workers not processing jobs.

---

## Step 1: Assess queue state

```bash
# Check worker pod status
kubectl get pods -n velvet -l app=velvet-workers

# Check queue depths via Redis
kubectl exec -n velvet deployment/velvet-api -- sh -c '
  node -e "
  const IORedis = require(\"ioredis\");
  const r = new IORedis(process.env.REDIS_URL);
  const queues = [\"webhook-processing\",\"notification\",\"media-processing\",\"subscription\",\"moderation\"];
  Promise.all(queues.map(q => r.llen(\"bull:\"+q+\":wait\").then(n => ({queue:q,waiting:n}))))
    .then(r => { console.table(r); process.exit(0); })
  "
'
```

---

## Step 2: Decision tree

### Workers in CrashLoopBackOff
```bash
kubectl logs -n velvet -l app=velvet-workers --previous --tail=100
# Fix the error, then:
kubectl rollout restart deployment/velvet-workers -n velvet
```

### Workers running but not processing
```bash
# Check stalled jobs (BullMQ marks active jobs as stalled after ~30s with no heartbeat)
# Stalled jobs return to WAITING automatically on next worker heartbeat check
# Force stalled job recovery: restart workers
kubectl rollout restart deployment/velvet-workers -n velvet
```

### Queue depth high but workers running
```bash
# Scale workers temporarily
kubectl scale deployment/velvet-workers --replicas=10 -n velvet

# Monitor queue drain rate
watch -n5 'kubectl exec -n velvet deployment/velvet-api -- node -e \
  "const r=require(\"ioredis\"); const c=new r(process.env.REDIS_URL); \
   c.llen(\"bull:webhook-processing:wait\").then(n=>{console.log(n);process.exit(0)})"'

# After queue drains, scale back
kubectl scale deployment/velvet-workers --replicas=2 -n velvet
```

---

## Step 3: Failed job triage

```bash
# Count failed jobs per queue
node -e "
const {Queue} = require('bullmq');
const IORedis = require('ioredis');
const redis = new IORedis(process.env.REDIS_URL);
const queues = ['webhook-processing','notification','media-processing'];
Promise.all(queues.map(async name => {
  const q = new Queue(name, {connection: redis});
  const counts = await q.getJobCounts('failed','active','waiting','completed');
  return {name, ...counts};
})).then(r => { console.table(r); process.exit(0); });
"
```

### Re-process failed jobs (safe for idempotent jobs)
```bash
node -e "
const {Queue} = require('bullmq');
const IORedis = require('ioredis');
const redis = new IORedis(process.env.REDIS_URL);
const q = new Queue('notification', {connection: redis});
// Retry all failed jobs in the last 24h
q.retryJobs({state:'failed', count:1000, timestamp: Date.now() - 86400000})
  .then(count => { console.log('Re-queued:', count); process.exit(0); });
"
```

---

## Step 4: Notification queue flooding (viral event)

If notification queue depth explodes due to a viral match/feature event:

```bash
# Pause notification queue (non-critical — users will get notifications when resumed)
node -e "
const {Queue} = require('bullmq');
const IORedis = require('ioredis');
const redis = new IORedis(process.env.REDIS_URL);
const q = new Queue('notification', {connection: redis});
q.pause().then(() => { console.log('Queue paused'); process.exit(0); });
"

# Resume when ready
node -e "...q.resume()..."
```

**Do NOT pause**: `webhook-processing` (payment webhooks), `subscription` (renewal jobs)

---

## Step 5: Dead-letter review

Jobs that have exhausted all retries end up in failed state permanently. Weekly review:

```bash
# List recent permanently failed jobs with error
node -e "
const {Queue} = require('bullmq');
const IORedis = require('ioredis');
const redis = new IORedis(process.env.REDIS_URL);
const q = new Queue('webhook-processing', {connection: redis});
q.getFailed(0, 20).then(jobs => {
  jobs.forEach(j => console.log({id:j.id, name:j.name, error:j.failedReason?.slice(0,100)}));
  process.exit(0);
});
"
```
