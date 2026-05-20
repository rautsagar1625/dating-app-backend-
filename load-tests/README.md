# Load Testing — Velvet Platform

## Prerequisites

```bash
# Install k6
brew install k6           # macOS
# or: https://k6.io/docs/getting-started/installation/

# Required env vars
export BASE_URL=https://api-staging.velvet.app
export WS_URL=wss://api-staging.velvet.app
```

## Test Suite

| Script | Purpose | VUs | Duration |
|--------|---------|-----|----------|
| `smoke.js` | Baseline health check — run before every load test | 5 | 70s |
| `load.js` | Realistic multi-scenario traffic simulation | 200+ | 10m |
| `websocket.js` | 500 concurrent WebSocket connections + message delivery | 500 | ~8m |
| `payment.js` | Payment idempotency, rate limiting, webhook replay | 50-80 | 10m |
| `media.js` | Presigned URL generation + S3 upload throughput | 30 | 5m |

## Running Tests

```bash
# Smoke test (run first — verifies API is healthy)
k6 run load-tests/k6/smoke.js --env BASE_URL=$BASE_URL

# Full load test with summary output
k6 run load-tests/k6/load.js \
  --env BASE_URL=$BASE_URL \
  --summary-trend-stats='min,med,p(90),p(95),p(99),max'

# WebSocket concurrency test
k6 run load-tests/k6/websocket.js \
  --env BASE_URL=$BASE_URL \
  --env WS_URL=$WS_URL

# Payment stress test
k6 run load-tests/k6/payment.js --env BASE_URL=$BASE_URL

# Media upload throughput
k6 run load-tests/k6/media.js --env BASE_URL=$BASE_URL

# Run all non-destructive tests in sequence
for test in smoke load websocket media; do
  k6 run load-tests/k6/$test.js --env BASE_URL=$BASE_URL
done
```

## Performance Thresholds (pass/fail)

| Metric | Threshold | Notes |
|--------|-----------|-------|
| `http_req_duration` p95 | < 500ms | Global across all endpoints |
| `http_req_duration` p99 | < 1500ms | Outlier tolerance |
| `http_req_failed` | < 1% | 4xx/5xx rate |
| `message_delivery_latency_ms` p95 | < 2000ms | WS message round-trip |
| `presigned_url_latency_ms` p95 | < 200ms | S3 presign generation |
| `payment_intent_success` | > 90% | Payment intents succeeding |
| `swipe_success` | > 95% | Swipe actions processed |
| `ws_delivery_success` | > 98% | Message delivery rate |

Tests **fail CI** if any threshold is breached.

## Interpreting Results

**k6 output key fields**:
```
http_req_duration............: avg=180ms min=12ms med=140ms max=2.1s p(90)=320ms p(95)=480ms p(99)=1.1s
http_req_failed..............: 0.12%  ← should be < 1%
http_reqs....................: 48230  ← total requests
iteration_duration...........: avg=4.2s
vus..........................: 150    ← active VUs at end
```

**Red flags**:
- p99 > 5s → severe tail latency, investigate DB slow queries
- `http_req_failed` > 2% → error spike, check Sentry immediately after
- `ws_connection_errors` > 50 → WebSocket infrastructure issue
- `idempotency_violations` > 0 → **CRITICAL** — payment safety broken

## Grafana Integration (k6 + InfluxDB)

```bash
# Send results to InfluxDB for Grafana dashboards
k6 run --out influxdb=http://localhost:8086/velvet-k6 load-tests/k6/load.js
```

Use the k6 Grafana dashboard template (ID: 2587) for real-time visualization.

## Pre-Production Load Testing Checklist

Before each production release:
- [ ] Smoke test passes on staging
- [ ] Load test: p95 < 500ms at 200 concurrent users
- [ ] WebSocket test: 500 concurrent connections stable for 5 min
- [ ] Payment idempotency test: 0 violations
- [ ] No new Sentry errors during test run
- [ ] DB connection count stays < 80% of pool max
- [ ] Redis memory stays < 70% of limit
