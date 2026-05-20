# Velvet — Production Launch Pre-Flight Checklist

**Sign off each item before launch. Owner must be named.**

---

## Infrastructure

- [ ] PostgreSQL: PgBouncer configured in transaction mode (max 20 server connections, 200 client connections)
- [ ] PostgreSQL: `max_connections` reviewed — RDS default 85 for db.t3.medium is fine for PgBouncer setup
- [ ] Redis: AOF persistence enabled (`appendonly yes`) — verify with `redis-cli CONFIG GET appendonly`
- [ ] Redis: `maxmemory-policy allkeys-lru` set — verify with `redis-cli CONFIG GET maxmemory-policy`
- [ ] Redis: memory limit set appropriately (≥ 512MB for production, ≥ 1GB for > 5k concurrent users)
- [ ] All secrets are production values, not staging or dev defaults — run `scripts/audit-secrets.sh`
- [ ] JWT secrets are ≥ 64 characters (enforced by `src/config/env.ts` in production mode)
- [ ] ENCRYPTION_KEY is exactly 64 hex characters (32 bytes)
- [ ] S3 buckets: versioning enabled on both media and private buckets
- [ ] S3 buckets: lifecycle rule — delete temp upload chunks (`uploads/tmp/`) after 24h
- [ ] S3 private bucket: public access block confirmed ON (AWS Console → Block Public Access)
- [ ] CloudFront: HTTPS-only policy (redirect HTTP → HTTPS)
- [ ] CloudFront: Origin Access Control (OAC) configured — S3 bucket only accessible via CloudFront
- [ ] CloudFront: Cache-Control `max-age=31536000` set for all media (immutable content)
- [ ] SSL certificate: valid, covering `api.velvet.app` and `*.velvet.app`, auto-renewal configured
- [ ] SSL certificate: expiry > 90 days from launch date
- [ ] DNS: A/AAAA records for `api.velvet.app` pointing to load balancer, TTL lowered to 60s 24h before launch
- [ ] Kubernetes: ResourceQuota applied to `velvet` namespace
- [ ] Kubernetes: LimitRange applied (prevents unbounded resource consumption)
- [ ] Kubernetes: PodDisruptionBudgets applied — `minAvailable: 2` for API, `minAvailable: 1` for workers

---

## Security

- [ ] Stripe: **live mode** API key (`sk_live_...`) — NOT test key (`sk_test_...`)
- [ ] Stripe: production webhook endpoint registered at `https://api.velvet.app/api/v1/payments/webhooks/stripe`
- [ ] Razorpay: production key (not test mode)
- [ ] Apple IAP: production bundle ID matches App Store, NOT sandbox mode
- [ ] Google Play: production service account, NOT sandbox/test environment
- [ ] All webhook secrets: production values set in k8s secrets
- [ ] CORS origins: restricted to `https://velvet.app` — no localhost in production
- [ ] Rate limiting thresholds reviewed: `RATE_LIMIT_MAX_REQUESTS=100` for global, `10` for auth endpoints
- [ ] File upload MIME types: restricted to `image/jpeg,image/png,image/webp,image/avif,video/mp4,audio/aac,audio/mpeg`
- [ ] Max upload size: 50MB enforced at both app and ingress level
- [ ] Admin accounts: all admins have MFA enabled in your auth system
- [ ] Admin user list audited: remove any test/dev admin accounts
- [ ] `npm audit --audit-level=high` passes with 0 high/critical issues
- [ ] Container image Trivy scan: 0 CRITICAL CVEs (CI pipeline enforces this)
- [ ] `.env` files in `.gitignore` — verify: `git ls-files | grep -E '\.env'` returns nothing
- [ ] No secrets in git history: `git log --all --full-history -- '*.env'` returns nothing
- [ ] `SENTRY_DSN` set — enforced by env.ts in production mode

---

## Database

- [ ] All Prisma migrations applied: `npx prisma migrate status` shows all migrations as "Applied"
- [ ] No pending migrations: `npx prisma migrate diff --from-schema-datasource --to-schema-datamodel` is empty
- [ ] Index audit: run `SELECT query, mean_exec_time, calls FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10` — all top queries use indexes (no Seq Scan on large tables)
- [ ] RDS PITR (Point-in-Time Recovery) enabled — verify in AWS Console
- [ ] Automated daily backup retention: ≥ 30 days
- [ ] Backup restoration tested (restore to staging, verify data integrity)
- [ ] Read replica: lag monitoring in place (`SELECT now() - pg_last_xact_replay_timestamp()`)
- [ ] DB `statement_timeout` set: `DB_STATEMENT_TIMEOUT_MS=10000` — prevents runaway queries

---

## Payments

- [ ] Stripe live mode payment E2E tested: create subscription → webhook received → subscription activated
- [ ] Apple IAP E2E tested: iOS purchase → receipt validated → subscription activated
- [ ] Google Play E2E tested: Android purchase → Pub/Sub notification received → subscription activated
- [ ] Refund flow tested: initiate refund → webhook received → subscription cancelled
- [ ] All payment webhook endpoints reachable from provider IP ranges (check firewall/security groups)
- [ ] Idempotency key test: same key sent twice → only 1 charge created
- [ ] Stripe webhook tolerance: 300s — events older than 5 min rejected

---

## Monitoring & Alerting

- [ ] Sentry: production DSN set, source maps uploaded, error alerts configured
- [ ] Sentry: alert for new error groups (≥ 10 occurrences/hour) → Slack #alerts
- [ ] Grafana: all dashboards load with production Prometheus data source
- [ ] PagerDuty: on-call rotation configured, escalation policy tested (send test alert)
- [ ] All Prometheus alert rules deployed and tested (fire test alerts, verify PagerDuty received)
- [ ] Uptime monitoring: external ping on `https://api.velvet.app/live` every 1 min (Better Uptime or similar)
- [ ] Log aggregation: structured JSON logs flowing to CloudWatch/Datadog/Loki — verify with test log
- [ ] `velvet_payment_success_total` metric visible in Grafana — payment health tracked

---

## Application

- [ ] Feature flags: production LaunchDarkly environment set, all flags reviewed for launch state
- [ ] Feature flag `BETA_ACCESS`: disabled (open signup) OR enabled (invite-only for beta)
- [ ] Email: production SMTP/SES configured, DKIM and SPF records set, test email delivered
- [ ] Email bounce handling: SES bounce notifications → suppress list updated
- [ ] Push notifications: APNs production certificate (NOT sandbox), FCM production credentials
- [ ] Worker concurrency: `WORKER_CONCURRENCY=10` for production (not the default 5)
- [ ] `NODE_ENV=production` — enforces strict validation, enables Sentry, disables dev tooling

---

## Mobile

- [ ] iOS: TestFlight beta completed with ≥ 25 testers, 0 critical crashes in past 7 days
- [ ] iOS: App Store review **approved** (not just submitted)
- [ ] iOS: Release scheduled in App Store Connect (not auto-released)
- [ ] Android: Internal → Alpha testing completed with 0 crash-free session rate degradation
- [ ] Android: Production rollout configured for 10% staged rollout
- [ ] OTA update (Expo EAS): `eas update` channel set to `production`, runtime compatible
- [ ] App version numbers: correct semver on both platforms, build numbers incremented past beta builds
- [ ] App Store listing: screenshots, description, privacy policy URL all set
- [ ] Privacy policy: accessible at `https://velvet.app/privacy`, up to date
- [ ] Terms of service: accessible at `https://velvet.app/terms`
- [ ] GDPR data deletion flow: tested — user can request account deletion, data removed within 30 days

---

## Operational Readiness

- [ ] All runbooks in `runbooks/` reviewed by on-call team — everyone knows where they are
- [ ] On-call rotation: 24/7 coverage for launch week (≥ 2 people per shift)
- [ ] Support workflow: Intercom/Zendesk configured, `support@velvet.app` active, SLA defined
- [ ] Status page: `status.velvet.app` configured, linked from app and website
- [ ] Rollback procedure: practiced in staging — all on-call engineers have run `kubectl rollout undo` at least once
- [ ] Launch communication: waitlist emails ready to send, social media scheduled
- [ ] Legal: CCPA/GDPR data processing agreements in place
- [ ] Cookie consent: implemented in mobile app (if using any tracking SDKs)
- [ ] App Store age rating: correctly set (17+ for dating apps)

---

## 1-Hour Pre-Launch Checklist

- [ ] Deploy production image — monitor for 15 min before traffic
- [ ] Run `curl https://api.velvet.app/live` → `{"status":"ok"}`
- [ ] Run `curl https://api.velvet.app/ready` → `{"status":"ok"}`
- [ ] Open Grafana launch dashboard — all panels green
- [ ] Confirm PagerDuty on-call is active
- [ ] All on-call engineers are at their computers
- [ ] Slack #launches channel created, stakeholders invited
- [ ] DNS TTL already reduced to 60s (must be done ≥ 1h beforehand)
- [ ] Post in #launches: `🚀 Launch T-1h. Grafana: [link]. Status: [link]. On-call: @[name]`
