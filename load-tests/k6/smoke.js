// ── Smoke Test — 5 VUs, 1 minute ─────────────────────────────────────────────
// Run: k6 run load-tests/k6/smoke.js --env BASE_URL=https://api-staging.velvet.app

import http  from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, jsonHeaders, authHeaders, randomChoice, TEST_USERS } from './config.js';

export const options = {
  stages: [
    { duration: '10s', target: 5 },
    { duration: '50s', target: 5 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed:   ['rate<0.01'],
  },
};

export function setup() {
  // Verify health before starting
  const res = http.get(`${BASE_URL}/live`);
  if (res.status !== 200) throw new Error(`API not healthy: ${res.status}`);
  return {};
}

export default function () {
  // 1. Health check
  {
    const res = http.get(`${BASE_URL}/live`);
    check(res, {
      'health: status 200': (r) => r.status === 200,
      'health: has status key': (r) => r.json('status') === 'ok',
      'health: response < 50ms': (r) => r.timings.duration < 50,
    });
  }
  sleep(0.5);

  // 2. Auth flow
  const user = randomChoice(TEST_USERS);
  let token;
  {
    const res = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      JSON.stringify({ email: user.email, password: user.password }),
      { headers: jsonHeaders() },
    );
    const ok = check(res, {
      'login: status 200': (r) => r.status === 200,
      'login: has accessToken': (r) => !!r.json('data.accessToken'),
    });
    if (ok) token = res.json('data.accessToken');
  }
  sleep(0.5);

  // 3. Get profile (authenticated)
  if (token) {
    const res = http.get(`${BASE_URL}/api/v1/profile/me`, { headers: authHeaders(token) });
    check(res, {
      'profile: status 200': (r) => r.status === 200,
      'profile: has id': (r) => !!r.json('data.id'),
    });
  }
  sleep(0.5);

  // 4. Discover feed
  if (token) {
    const res = http.get(`${BASE_URL}/api/v1/discover`, { headers: authHeaders(token) });
    check(res, {
      'discover: status 200 or 204': (r) => [200, 204].includes(r.status),
      'discover: < 500ms': (r) => r.timings.duration < 500,
    });
  }
  sleep(1);
}
