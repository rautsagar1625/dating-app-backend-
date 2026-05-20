# Runbook: PostgreSQL Failover

**Trigger**: DB connection pool exhausted, queries timing out, `DBPoolExhausted` alert.

---

## Step 1: Verify the problem

```bash
# Test DB connectivity from a pod
kubectl exec -n velvet deployment/velvet-api -- \
  node -e "const {Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query('SELECT 1')).then(r=>console.log('DB OK',r.rows)).catch(e=>console.error('DB FAIL',e.message)).finally(()=>c.end())"

# Check active connections (run via psql if accessible)
# SELECT count(*), state FROM pg_stat_activity GROUP BY state;
# SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;  -- on replica
```

### Check RDS status (if using AWS RDS)
```bash
aws rds describe-db-instances --db-instance-identifier velvet-prod \
  --query 'DBInstances[0].{Status:DBInstanceStatus,MultiAZ:MultiAZ,Endpoint:Endpoint.Address}'
```

---

## Step 2: Failover Procedures

### Option A: RDS Multi-AZ automatic failover (preferred)
RDS Multi-AZ fails over automatically in 60–120 seconds. Monitor:
```bash
aws rds describe-events --source-identifier velvet-prod --source-type db-instance --duration 60
```
Pods will reconnect automatically when RDS DNS updates (usually < 2 min).

### Option B: Manual RDS failover trigger
```bash
aws rds failover-db-cluster --db-cluster-identifier velvet-prod
# Or for single-AZ:
aws rds reboot-db-instance --db-instance-identifier velvet-prod --force-failover
```

### Option C: Manual replica promotion (self-managed Postgres)
```bash
# On the replica server:
pg_ctl promote -D /var/lib/postgresql/data

# Update k8s secret with new primary URL:
kubectl patch secret velvet-api-secrets -n velvet \
  --type='json' -p='[{"op":"replace","path":"/data/DATABASE_URL","value":"'$(echo -n "postgresql://USER:PASS@NEW_HOST:5432/velvet" | base64)'"}]'

# Rolling restart to pick up new DB URL:
kubectl rollout restart deployment/velvet-api -n velvet
kubectl rollout restart deployment/velvet-workers -n velvet
```

---

## Step 3: Data integrity check after failover

```bash
# Check row counts on critical tables (compare with known baseline)
kubectl exec -n velvet deployment/velvet-api -- node -e "
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
Promise.all([
  p.user.count(),
  p.paymentSession.count({where:{status:'SUCCESS'}}),
  p.subscription.count({where:{status:'ACTIVE'}}),
]).then(([users,payments,subs]) => {
  console.log({users,payments,subs});
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
"
```

---

## Step 4: Queue recovery after failover

Workers that were mid-job during failover may have stalled jobs:

```bash
# Find PROCESSING payment sessions older than 15 min
kubectl exec -n velvet deployment/velvet-api -- node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.paymentSession.findMany({
  where:{status:'PROCESSING',createdAt:{lt:new Date(Date.now()-15*60000)}},
  select:{id:true,userId:true,createdAt:true,providerIntentId:true}
}).then(r=>{console.log(JSON.stringify(r,null,2));process.exit(0)});
"
# → Trigger reconciliation: POST /admin/payments/reconcile
```

---

## Step 5: Fail back to original primary

Only after verifying:
1. Original primary is healthy: `aws rds describe-db-instances`
2. Replica has caught up: replication lag < 1s
3. Traffic is stable on new primary

```bash
# RDS: another failover (triggers a planned failover back)
aws rds failover-db-cluster --db-cluster-identifier velvet-prod
```

Monitor for 30 min after failback before declaring resolved.
