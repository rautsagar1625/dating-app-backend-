# Runbook: Payment Processing Incident

**Trigger**: `PaymentHighFailureRate` alert, or users reporting payment failures.

---

## Step 1: Assess impact

```bash
# Count PROCESSING sessions older than 15 min (stuck)
kubectl exec -n velvet deployment/velvet-api -- node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.paymentSession.count({
  where:{status:'PROCESSING',createdAt:{lt:new Date(Date.now()-15*60000)}}
}).then(n=>{console.log('Stuck sessions:',n);process.exit(0)});
"

# Check failure rate by provider
kubectl exec -n velvet deployment/velvet-api -- node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.paymentSession.groupBy({
  by:['provider','status'],
  where:{createdAt:{gte:new Date(Date.now()-3600000)}},
  _count:{id:true}
}).then(r=>{console.table(r);process.exit(0)});
"
```

---

## Step 2: Triage by provider

### Stripe
1. Check status: https://status.stripe.com
2. Check webhook delivery: Stripe Dashboard → Developers → Webhooks → endpoint → recent deliveries
3. Check API errors: Stripe Dashboard → Developers → Logs → filter by status 4xx/5xx
4. Verify webhook secret hasn't changed: `kubectl get secret velvet-api-secrets -n velvet -o jsonpath='{.data.STRIPE_WEBHOOK_SECRET}' | base64 -d`

### Razorpay
1. Check Razorpay Dashboard → Webhooks → Recent events
2. Verify signature mismatch rate in API logs

### Apple IAP
1. Check App Store Connect status: https://developer.apple.com/system-status/
2. Check receipt validation API: https://status.apple.com

### Google Play
1. Check Google Cloud Console → Pub/Sub → velvet-play-notifications topic → subscription ack rate
2. Unack'd messages = webhook not reaching our endpoint

---

## Step 3: Duplicate charge investigation

```sql
-- Run via psql or DB admin tool
SELECT "userId", COUNT(*) as charge_count, SUM("amountUsd") as total
FROM "PaymentSession"
WHERE status = 'SUCCESS'
  AND "createdAt" > NOW() - INTERVAL '1 hour'
GROUP BY "userId"
HAVING COUNT(*) > 2
ORDER BY charge_count DESC;
```

If duplicates found → **immediate refund required**:
```bash
# Stripe refund (replace ch_xxx with actual charge ID)
curl -X POST https://api.stripe.com/v1/refunds \
  -u $STRIPE_SECRET_KEY: \
  -d charge=ch_xxx \
  -d reason=duplicate
```

---

## Step 4: Manual reconciliation

```bash
# Trigger reconciliation worker (re-queries provider for all PROCESSING sessions)
curl -X POST https://api.velvet.app/admin/payments/reconcile \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Step 5: Communication

If payment failures last > 15 min, post in-app notification and update status page:

```
Title: Payment processing degraded
Body: We're experiencing issues processing some payments. Your payment has not been charged.
      We're actively working on a fix. If you've been charged incorrectly, contact support.
```

---

## Step 6: Prevention

After incident resolution:
- Review idempotency key collision rate in logs
- Verify webhook tolerance seconds is appropriate (default 300s)
- Check if reconciliation job ran during outage
