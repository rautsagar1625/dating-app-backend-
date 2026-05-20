// ── k6 shared configuration ───────────────────────────────────────────────────

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3002';
export const WS_URL   = __ENV.WS_URL   || 'ws://localhost:3002';

export const THRESHOLDS = {
  http_req_duration: ['p(95)<500', 'p(99)<1500'],
  http_req_failed:   ['rate<0.01'],
  http_reqs:         ['rate>10'],
};

export const WS_THRESHOLDS = {
  ws_connecting:       ['p(95)<1000'],
  ws_session_duration: ['p(95)<600000'],
};

export function authHeaders(token) {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

export function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

export function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pre-generated test user pool — replace with real seeded test accounts
export const TEST_USERS = Array.from({ length: 100 }, (_, i) => ({
  email:    `loadtest_user_${i}@velvet-test.internal`,
  password: 'LoadTest@123',
}));
