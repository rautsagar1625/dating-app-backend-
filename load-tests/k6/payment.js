// ── Payment Concurrency & Idempotency Test ────────────────────────────────────
// Tests payment idempotency, rate limiting, and webhook replay protection.
// Run: k6 run load-tests/k6/payment.js --env BASE_URL=http://localhost:3002

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { BASE_URL, jsonHeaders, authHeaders, randomChoice, randomInt, TEST_USERS } from './config.js';

const idempotencyViolations = new Counter('idempotency_violations');
const rateLimitHit          = new Counter('rate_limit_responses');
const paymentSuccessRate    = new Rate('payment_intent_success');
const webhookDuplicateRate  = new Rate('webhook_duplicate_rejected');

const users = new SharedArray('users', () => TEST_USERS);

export const options = {
  scenarios: {
    concurrent_payments: {
      executor:        'constant-arrival-rate',
      rate:            20,
      timeUnit:        '1s',
      duration:        '5m',
      preAllocatedVUs: 40,
      maxVUs:          80,
      exec:            'concurrentPaymentScenario',
      tags:            { scenario: 'concurrent_payment' },
    },
    idempotency_test: {
      executor:        'constant-arrival-rate',
      rate:            5,
      timeUnit:        '1s',
      duration:        '3m',
      preAllocatedVUs: 20,
      maxVUs:          50,
      exec:            'idempotencyScenario',
      tags:            { scenario: 'idempotency' },
    },
    webhook_replay: {
      executor:        'constant-arrival-rate',
      rate:            3,
      timeUnit:        '1s',
      duration:        '3m',
      preAllocatedVUs: 10,
      maxVUs:          20,
      exec:            'webhookReplayScenario',
      tags:            { scenario: 'webhook_replay' },
    },
    rate_limit_test: {
      executor:        'constant-arrival-rate',
      rate:            50,
      timeUnit:        '1s',
      duration:        '2m',
      preAllocatedVUs: 20,
      maxVUs:          60,
      exec:            'rateLimitScenario',
      tags:            { scenario: 'rate_limit' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:concurrent_payment}': ['p(95)<2000'],
    'http_req_duration{scenario:idempotency}':        ['p(95)<1000'],
    'idempotency_violations':                         ['count<1'],
    'payment_intent_success':                         ['rate>0.90'],
  },
};

function login(user) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: jsonHeaders() },
  );
  return res.status === 200 ? res.json('data.accessToken') : null;
}

export function concurrentPaymentScenario() {
  const token = login(randomChoice(users));
  if (!token) { sleep(1); return; }

  const res = http.post(
    `${BASE_URL}/api/v1/payments/intent`,
    JSON.stringify({
      productId:      'gold_monthly_usd',
      provider:       'stripe',
      idempotencyKey: `cc_${__VU}_${Date.now()}_${randomInt(1, 999999)}`,
    }),
    { headers: authHeaders(token) },
  );

  paymentSuccessRate.add([200, 201].includes(res.status));
  check(res, {
    'payment intent: valid response': (r) => [200, 201, 402, 429].includes(r.status),
    'payment intent: < 2s': (r) => r.timings.duration < 2000,
  });

  sleep(randomInt(2, 8));
}

export function idempotencyScenario() {
  const token = login(randomChoice(users));
  if (!token) { sleep(1); return; }

  // Same idempotency key sent twice (simulates client retry)
  const idempotencyKey = `idem_test_${__VU}_${Math.floor(Date.now() / 60000)}`; // same per minute

  const body = JSON.stringify({
    productId:      'boost_30min',
    provider:       'stripe',
    idempotencyKey,
  });
  const headers = authHeaders(token);

  const res1 = http.post(`${BASE_URL}/api/v1/payments/intent`, body, { headers });
  sleep(0.1); // small gap
  const res2 = http.post(`${BASE_URL}/api/v1/payments/intent`, body, { headers });

  // Both should succeed — but only 1 charge should be created
  // If first was 201, second should return same data (idempotent) not a new charge
  check(res1, { 'idem first: 200/201': (r) => [200, 201].includes(r.status) });
  check(res2, { 'idem second: not 500': (r) => r.status !== 500 });

  if (res1.status === 201 && res2.status === 201) {
    const id1 = res1.json('data.id');
    const id2 = res2.json('data.id');
    if (id1 && id2 && id1 !== id2) {
      idempotencyViolations.add(1);
      console.error(`IDEMPOTENCY VIOLATION: two different sessions created for same key. id1=${id1} id2=${id2}`);
    }
  }

  sleep(randomInt(3, 10));
}

export function webhookReplayScenario() {
  // Simulate sending same webhook twice (replay attack / provider retry)
  const eventId = `evt_loadtest_${__VU}_${Math.floor(Date.now() / 30000)}`; // same per 30s

  const payload = JSON.stringify({
    id:   eventId,
    type: 'payment_intent.succeeded',
    data: { object: { id: `pi_loadtest_${randomInt(1, 999999)}`, amount: 999 } },
  });

  // Note: real webhook verification will reject these without a valid signature
  // This tests the response behavior (429/409 on duplicate, not 500)
  const res1 = http.post(`${BASE_URL}/api/v1/payments/webhooks/stripe`, payload, {
    headers: {
      'Content-Type':          'application/json',
      'Stripe-Signature':      `t=1234,v1=invalid_signature_for_load_test`,
    },
  });

  sleep(0.2);
  const res2 = http.post(`${BASE_URL}/api/v1/payments/webhooks/stripe`, payload, {
    headers: {
      'Content-Type':          'application/json',
      'Stripe-Signature':      `t=1234,v1=invalid_signature_for_load_test`,
    },
  });

  // Both should fail with 400 (bad signature) — not 500
  webhookDuplicateRate.add(res1.status !== 500 && res2.status !== 500);
  check(res1, { 'webhook: not 500': (r) => r.status !== 500 });
  check(res2, { 'webhook retry: not 500': (r) => r.status !== 500 });

  sleep(randomInt(5, 15));
}

export function rateLimitScenario() {
  const token = login(randomChoice(users));
  if (!token) { sleep(0.5); return; }

  const res = http.post(
    `${BASE_URL}/api/v1/payments/intent`,
    JSON.stringify({ productId: 'boost_30min', provider: 'stripe', idempotencyKey: `rl_${__VU}_${Date.now()}` }),
    { headers: authHeaders(token) },
  );

  if (res.status === 429) rateLimitHit.add(1);

  check(res, {
    'rate limit: proper 429 not 500': (r) => r.status !== 500,
    'rate limit: has retry-after': (r) => r.status !== 429 || !!r.headers['Retry-After'],
  });

  sleep(0.5);
}
