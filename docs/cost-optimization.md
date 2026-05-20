# Velvet — Production Cost Optimization Guide

---

## Infrastructure Cost Estimate (5,000 MAU)

| Component | Service | Est. Monthly |
|-----------|---------|-------------|
| API compute | 3× EKS t3.medium + cluster | $150 |
| Workers | 2× t3.small | $35 |
| Database | RDS db.t3.medium Multi-AZ | $120 |
| Redis | ElastiCache cache.t3.medium | $55 |
| S3 storage | 500GB media | $12 |
| CloudFront | 2TB out/month | $170 |
| ALB | 1 load balancer | $20 |
| Route53 + misc | — | $10 |
| **Total** | | **~$572/month** |
| Per MAU | | **~$0.11** |

At 100,000 MAU projection: ~$4,000/month (~$0.04/MAU) — economies of scale from CDN caching and DB sharing.

---

## CDN & Media (Biggest Cost Driver — ~30% of total)

### CloudFront cache hit rate (target: > 90%)

**Problem**: Cache miss = CloudFront fetches from S3 = origin cost + latency.

**Fix 1**: Set immutable Cache-Control headers on all media:
```typescript
// In your S3 upload code (media pipeline)
await s3.putObject({
  ...
  CacheControl: 'public, max-age=31536000, immutable',  // 1 year
}).promise();
```

**Fix 2**: Use CloudFront cache policies, not legacy headers. Set TTL max to 1 year for all `/media/` paths.

**Fix 3**: Compress images at upload time — already using `sharp` in media pipeline. Add:
```typescript
// In media processing worker — convert JPEG to WebP
.toFormat('webp', { quality: 85 })
// Average 30% smaller than JPEG at same quality
```

**Fix 4**: Serve responsive images — generate 3 sizes at upload (thumbnail 100px, medium 480px, large 1080px). Clients request the appropriate size. Avoid sending 1080px to thumbnail slots.

### S3 cost reduction

Enable Intelligent-Tiering for media older than 30 days (automatic move to cheaper storage class):
```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket velvet-media-prod \
  --lifecycle-configuration file://lifecycle.json
```

lifecycle.json:
```json
{
  "Rules": [{
    "ID": "IntelligentTiering",
    "Status": "Enabled",
    "Filter": {"Prefix": "media/"},
    "Transitions": [{"Days": 30, "StorageClass": "INTELLIGENT_TIERING"}]
  }, {
    "ID": "DeleteTempUploads",
    "Status": "Enabled",
    "Filter": {"Prefix": "uploads/tmp/"},
    "Expiration": {"Days": 1}
  }]
}
```

---

## Database (Second-Biggest Cost)

### PgBouncer connection pooling

Without PgBouncer: 100 pods × 20 connections = 2,000 DB connections → requires db.r6g.large ($250/mo).  
With PgBouncer: 100 pods → PgBouncer → 20 DB connections → db.t3.medium ($60/mo) handles it.

Add PgBouncer as a sidecar or separate service — ROI: save $190/month immediately.

### Index audit (run quarterly)

```sql
-- Find missing indexes (sequential scans on large tables)
SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan,
       seq_tup_read / NULLIF(seq_scan, 0) AS avg_rows_per_scan
FROM pg_stat_user_tables
WHERE seq_scan > 100
ORDER BY seq_tup_read DESC
LIMIT 20;

-- Find unused indexes (wasting write overhead and disk space)
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND indexname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Find slow queries
SELECT query, mean_exec_time, calls, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### Read replica for analytics

Offload these to a read replica (already in entitlement engine and revenue analytics):
- `recomputeSegment` (whale intelligence — reads payment history)
- `getSubscriberRetentionCohort` (revenue analytics)
- `getRevenueSnapshot` queries

Savings: reduces primary DB I/O by ~25–30% at scale.

---

## Redis Optimization

### Memory compression (small hashes)

Add to Redis config:
```
hash-max-listpack-entries 128
hash-max-listpack-value 64
```
Reduces memory for small hashes by up to 50%.

### TTL audit (prevent unbounded growth)

Every Redis key must have a TTL. Keys without TTL = memory leak:
```bash
# Find keys without TTL (sample — run via redis-cli)
redis-cli --scan --pattern 'velvet:*' | head -1000 | xargs -L1 redis-cli ttl | sort -n | head -20
# Any "-1" value = no TTL = investigate
```

### Key prefix audit

All our Redis keys use `velvet:` prefix. Use this to monitor:
```bash
redis-cli --bigkeys 2>/dev/null | grep 'Biggest'
# Shows memory-hungry keys — investigate any > 1MB
```

---

## BullMQ Worker Efficiency

### Concurrency tuning by job type

| Queue | Job Type | CPU/IO | Target Concurrency |
|-------|----------|--------|--------------------|
| media-processing | CPU-bound (sharp) | CPU | = # CPU cores (4–8) |
| webhook-processing | IO-bound (HTTP calls) | IO | 20–50 |
| notification | IO-bound (push API) | IO | 50 |
| subscription | Mixed | Both | 10 |
| moderation | IO-bound (AI API) | IO | 20 |

### Spot instances for workers

Workers are stateless — on SIGTERM, BullMQ jobs return to queue automatically. Use AWS Spot:
```yaml
# In worker deployment
spec:
  nodeSelector:
    node.kubernetes.io/lifecycle: spot
  tolerations:
    - key: "spot"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
```
Savings: 60–70% vs on-demand. Workers = ~$170/month on-demand → ~$55/month on Spot.

### Batch notification jobs

Instead of 1 job per push notification:
```typescript
// Before: 10,000 jobs for a blast
await notificationQueue.addBulk(users.map(u => ({ name: 'push', data: { userId: u.id, ...msg } })));

// After: 100 batch jobs, each handling 100 users
await notificationQueue.addBulk(chunk(users, 100).map(batch => ({
  name: 'push-batch',
  data: { userIds: batch.map(u => u.id), ...msg }
})));
```
Reduces job overhead 100x. Redis memory and processing time both drop dramatically.

---

## WebSocket Cost Optimization

### Remove sticky sessions (big win)

Currently: Kubernetes ingress uses ClientIP affinity for Socket.IO.
Problem: uneven load distribution, can't scale down pods with active connections.

Solution: Socket.IO Redis Adapter already in your codebase — use it properly:
```typescript
// In socket setup — emit to any user regardless of which pod they're on
io.to(userId).emit('new_message', messageData);
// This works across pods via Redis pub/sub
```

With Redis Adapter: remove `sessionAffinity: ClientIP` from k8s service. Any pod handles any connection. Scale down freely.

---

## Compute Autoscaling (Cost-Aware)

### Time-based scaling with KEDA cron scaler

```yaml
# Scale down overnight (saves ~60% compute cost during off-hours)
- type: cron
  metadata:
    timezone: America/New_York
    start: 0 2 * * *   # 2am ET — scale down
    end: 0 8 * * *     # 8am ET — scale up
    desiredReplicas: "2"  # From 5 → 2 overnight
```

### Rightsizing after 2 weeks

After 2 weeks of production metrics:
1. Check `kubectl top pods -n velvet` — CPU/memory actual vs limits
2. Use AWS Compute Optimizer recommendations for EC2 instance sizing
3. Typical finding: memory limits 2x overprovisioned, CPU 3x underprovisioned

---

## 90-Day Cost Reduction Plan

| Action | Savings/Month | Effort |
|--------|--------------|--------|
| PgBouncer connection pooling | $190 | 4h |
| WebP conversion for images | $40 (CDN bandwidth) | 2h |
| S3 Intelligent-Tiering | $8 | 1h |
| Worker Spot instances | $115 | 4h |
| Overnight API scale-down | $50 | 2h |
| Notification batching | $20 (Redis + compute) | 4h |
| **Total** | **~$423/month** | **17h** |

These optimizations pay for a full engineer-month within the first month at scale.
