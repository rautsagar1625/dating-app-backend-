// ── Load Test — Realistic concurrent traffic simulation ───────────────────────
// Run: k6 run load-tests/k6/load.js --env BASE_URL=https://api-staging.velvet.app

import http  from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { BASE_URL, jsonHeaders, authHeaders, randomChoice, randomInt, TEST_USERS } from './config.js';

// Custom metrics
const swipeSuccessRate    = new Rate('swipe_success');
const feedLoadTime        = new Trend('feed_load_time', true);
const matchesCreated      = new Counter('matches_created');
const paymentAttemptRate  = new Rate('payment_attempt_success');

const users = new SharedArray('test_users', () => TEST_USERS);

export const options = {
  scenarios: {
    auth_flow: {
      executor:            'constant-arrival-rate',
      rate:                10,
      timeUnit:            '1s',
      duration:            '10m',
      preAllocatedVUs:     20,
      maxVUs:              50,
      exec:                'authScenario',
      tags:                { scenario: 'auth' },
    },
    feed_browsing: {
      executor:            'constant-arrival-rate',
      rate:                50,
      timeUnit:            '1s',
      duration:            '10m',
      preAllocatedVUs:     100,
      maxVUs:              200,
      exec:                'feedScenario',
      tags:                { scenario: 'feed' },
    },
    swipe_actions: {
      executor:            'constant-arrival-rate',
      rate:                30,
      timeUnit:            '1s',
      duration:            '10m',
      preAllocatedVUs:     60,
      maxVUs:              120,
      exec:                'swipeScenario',
      tags:                { scenario: 'swipe' },
    },
    payment_attempt: {
      executor:            'constant-arrival-rate',
      rate:                2,
      timeUnit:            '1s',
      duration:            '10m',
      preAllocatedVUs:     5,
      maxVUs:              20,
      exec:                'paymentScenario',
      tags:                { scenario: 'payment' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:auth}':    ['p(95)<800'],
    'http_req_duration{scenario:feed}':    ['p(95)<500'],
    'http_req_duration{scenario:swipe}':   ['p(95)<300'],
    'http_req_duration{scenario:payment}': ['p(95)<2000'],
    'http_req_failed':                     ['rate<0.02'],
    'swipe_success':                       ['rate>0.95'],
  },
};

// ── Token cache (VU-local) ────────────────────────────────────────────────────

let cachedToken = null;

function getToken() {
  if (cachedToken) return cachedToken;
  const user = randomChoice(users);
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: jsonHeaders() },
  );
  if (res.status === 200) {
    cachedToken = res.json('data.accessToken');
  }
  return cachedToken;
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

export function authScenario() {
  const user = randomChoice(users);

  // 50/50 split: register vs login
  if (Math.random() < 0.05) {
    // New user registration (less frequent)
    const res = http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({
        email:    `loadtest_new_${Date.now()}_${randomInt(1, 999999)}@velvet-test.internal`,
        password: 'LoadTest@123',
        name:     'Load Test User',
      }),
      { headers: jsonHeaders() },
    );
    check(res, { 'register: 201 or 409': (r) => [201, 409, 422].includes(r.status) });
  } else {
    const res = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      JSON.stringify({ email: user.email, password: user.password }),
      { headers: jsonHeaders() },
    );
    check(res, {
      'login: 200 or 401': (r) => [200, 401].includes(r.status),
      'login: response time < 800ms': (r) => r.timings.duration < 800,
    });
  }

  sleep(randomInt(1, 3));
}

export function feedScenario() {
  const token = getToken();
  if (!token) { sleep(1); return; }

  const start = Date.now();
  const res = http.get(
    `${BASE_URL}/api/v1/discover?limit=20`,
    { headers: authHeaders(token) },
  );
  feedLoadTime.add(Date.now() - start);

  check(res, {
    'feed: 200': (r) => r.status === 200,
    'feed: has profiles': (r) => Array.isArray(r.json('data')),
  });

  sleep(randomInt(2, 8)); // simulate user browsing
}

export function swipeScenario() {
  const token = getToken();
  if (!token) { sleep(1); return; }

  const direction = Math.random() < 0.3 ? 'like' : 'pass';
  const res = http.post(
    `${BASE_URL}/api/v1/swipe`,
    JSON.stringify({ targetUserId: `loadtest_target_${randomInt(1, 10000)}`, direction }),
    { headers: authHeaders(token) },
  );

  const ok = check(res, {
    'swipe: 200 or 201': (r) => [200, 201, 429].includes(r.status),
  });
  swipeSuccessRate.add(res.status === 200 || res.status === 201);

  if (res.status === 200 && res.json('data.matched')) {
    matchesCreated.add(1);
  }

  sleep(randomInt(1, 4));
}

export function paymentScenario() {
  const token = getToken();
  if (!token) { sleep(1); return; }

  const res = http.post(
    `${BASE_URL}/api/v1/payments/intent`,
    JSON.stringify({
      productId:      'gold_monthly_usd',
      provider:       'stripe',
      idempotencyKey: `load_test_${Date.now()}_${randomInt(1, 999999)}`,
    }),
    { headers: authHeaders(token) },
  );

  paymentAttemptRate.add([200, 201].includes(res.status));
  check(res, {
    'payment: 200/201 or 429/402': (r) => [200, 201, 402, 429].includes(r.status),
    'payment: < 2000ms': (r) => r.timings.duration < 2000,
  });

  sleep(randomInt(5, 15));
}
