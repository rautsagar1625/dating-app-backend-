# Runbook: Redis Incident

**Trigger**: `RedisDown` or `RedisHighMemory` alert, BullMQ jobs not processing, rate limiters returning 500 instead of 429.

---

## Step 1: Confirm Redis is actually down

```bash
# From inside the cluster
kubectl exec -n velvet deployment/velvet-api -- \
  node -e "const r=require('ioredis'); const c=new r(process.env.REDIS_URL,{maxRetriesPerRequest:1}); c.ping().then(v=>console.log('PING:',v)).catch(e=>console.error('FAIL:',e.message)).finally(()=>c.disconnect())"

# Or directly via redis-cli if accessible
redis-cli -u $REDIS_URL ping
```

---

## Step 2: Impact assessment

| Feature | Degrades if Redis down? | Behavior |
|---------|------------------------|----------|
| Rate limiting | Yes (fails open) | Returns 500 instead of 429 — no rate limiting |
| Offer engine | Yes (gracefully) | Fatigue/cooldown ignored — users get more offers |
| Entitlement cache | Yes (gracefully) | Falls back to DB (slower but correct) |
| Boost cache | Yes (partially) | Boost state not returned — users appear unboosted |
| Socket.IO rooms | Yes (hard) | Multi-pod room fan-out broken |
| BullMQ queues | Yes (hard) | All queue processing stops |
| JWT allowlist | Yes (gracefully) | Falls back to signature verification only |
| Whale/segment cache | Yes (gracefully) | Recomputed from DB per request (slow) |

**Immediate risk**: BullMQ stops entirely. Webhook processing, notifications, media processing all halt.

---

## Step 3: Recovery procedures

### Option A: ElastiCache (AWS) — automatic failover

If using ElastiCache with replication group, failover is automatic within 60s. Monitor:
```bash
aws elasticache describe-replication-groups \
  --replication-group-id velvet-redis-prod \
  --query 'ReplicationGroups[0].{Status:Status,PrimaryEndpoint:NodeGroups[0].PrimaryEndpoint}'
```

Wait for `Status: available`, then verify connectivity.

### Option B: Redis pod restart (self-managed)

```bash
kubectl rollout restart deployment/redis -n velvet
kubectl rollout status deployment/redis -n velvet --timeout=3m

# Verify
redis-cli -u $REDIS_URL ping
```

**Warning**: pod restart clears all Redis data (unless AOF persistence is enabled and the data volume persists).

### Option C: Redis data cleared (worst case)

If Redis came back empty (data lost), these effects are immediate:
- All active boost sessions lost → users' boosts appear expired
- All offer cooldowns reset → users may get more aggressive offer targeting temporarily
- All rate limiter counters reset → potential brief spike in request volume
- All entitlement cache cleared → first request per user hits DB (brief latency spike)
- BullMQ queue state lost → in-flight jobs lost

**Recovery steps after data loss**:
```bash
# 1. Recompute whale segments for top users (async — non-blocking)
curl -X POST https://api.velvet.app/admin/whale/recompute-top \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"limit": 1000}'

# 2. Warm entitlement cache (trigger re-cache for active subscribers)
curl -X POST https://api.velvet.app/admin/entitlements/warm-cache \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. Active boost sessions — query DB for boosts that should still be active
kubectl exec -n velvet deployment/velvet-api -- node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.boostCampaign.findMany({
  where:{status:'ACTIVE',expiresAt:{gt:new Date()}},
  select:{id:true,userId:true,multiplier:true,expiresAt:true}
}).then(r=>{console.log('Active boosts to re-cache:',r.length);console.log(JSON.stringify(r));process.exit(0)});
"
# → For each: re-call setBoost(userId, multiplier, remainingTtlSecs)
```

---

## Step 4: BullMQ queue recovery after Redis restart

Jobs that were ACTIVE when Redis died are now stalled. BullMQ will auto-recover stalled jobs after `stalledInterval` (default 30s) when workers reconnect.

```bash
# Verify workers reconnected and processing
kubectl logs -n velvet -l app=velvet-workers --tail=50 | grep -E '(connected|processing|stalled)'
```

If workers show "connected" but no jobs processing:
```bash
# Restart workers to force BullMQ reconnection and stall recovery
kubectl rollout restart deployment/velvet-workers -n velvet
```

---

## Step 5: Post-incident — TTL audit

After every Redis incident, audit for keys without TTL (memory leak risk):
```bash
# Sample 200 keys, check TTL
redis-cli -u $REDIS_URL --scan --count 200 | head -200 | \
  xargs -I{} sh -c 'ttl=$(redis-cli -u $REDIS_URL ttl {}); echo "$ttl {}"' | \
  awk '$1 == -1 {print "NO TTL:", $2}' | head -20
```

Any key with TTL = -1 is a leak candidate — investigate and add TTL.
