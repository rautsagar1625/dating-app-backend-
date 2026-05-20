// ── Media Upload Throughput Test ──────────────────────────────────────────────
// Tests presigned URL generation speed and CDN propagation.
// Run: k6 run load-tests/k6/media.js --env BASE_URL=http://localhost:3002

import http  from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, jsonHeaders, authHeaders, randomChoice, randomInt, TEST_USERS } from './config.js';

const presignedUrlLatency   = new Trend('presigned_url_latency_ms', true);
const uploadInitLatency     = new Trend('upload_initiation_ms', true);
const uploadSuccessRate     = new Rate('upload_success');
const confirmSuccessRate    = new Rate('upload_confirm_success');

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '4m',  target: 30 },
    { duration: '30s', target: 0  },
  ],
  thresholds: {
    'presigned_url_latency_ms': ['p(95)<200'],
    'upload_initiation_ms':     ['p(95)<500'],
    'upload_success':            ['rate>0.95'],
    'http_req_failed':           ['rate<0.05'],
  },
};

// Generate a random binary payload to simulate image upload
function generateFakeImage(sizeKb) {
  const bytes = new Uint8Array(sizeKb * 1024);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes.buffer;
}

function login(user) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: jsonHeaders() },
  );
  return res.status === 200 ? res.json('data.accessToken') : null;
}

export default function () {
  const user  = randomChoice(TEST_USERS);
  const token = login(user);
  if (!token) { sleep(2); return; }

  // ── 1. Request a presigned upload URL ─────────────────────────────────────
  const initStart = Date.now();
  const initRes = http.post(
    `${BASE_URL}/api/v1/media/upload/initiate`,
    JSON.stringify({
      mimeType:  'image/jpeg',
      fileSize:  randomInt(100, 2048) * 1024,  // 100KB – 2MB
      mediaType: 'PHOTO',
    }),
    { headers: authHeaders(token) },
  );
  presignedUrlLatency.add(Date.now() - initStart);
  uploadInitLatency.add(Date.now() - initStart);

  const initOk = check(initRes, {
    'upload initiate: 200': (r) => r.status === 200,
    'upload initiate: has uploadUrl': (r) => !!r.json('data.uploadUrl'),
    'upload initiate: < 500ms': (r) => r.timings.duration < 500,
  });

  if (!initOk) {
    uploadSuccessRate.add(false);
    sleep(2);
    return;
  }

  const { uploadUrl, sessionId, mediaId } = initRes.json('data');
  if (!uploadUrl) { uploadSuccessRate.add(false); sleep(2); return; }

  // ── 2. PUT to presigned S3 URL ────────────────────────────────────────────
  const imageData = generateFakeImage(randomInt(50, 500));
  const uploadRes = http.put(uploadUrl, imageData, {
    headers: { 'Content-Type': 'image/jpeg' },
    timeout: '30s',
  });

  const uploadOk = check(uploadRes, {
    'S3 upload: 200': (r) => [200, 201, 204].includes(r.status),
    'S3 upload: < 10s': (r) => r.timings.duration < 10000,
  });
  uploadSuccessRate.add(uploadOk);

  if (!uploadOk) { sleep(2); return; }

  // ── 3. Confirm upload completion (triggers media processing pipeline) ──────
  sleep(0.5); // brief pause to simulate S3 propagation

  const confirmRes = http.post(
    `${BASE_URL}/api/v1/media/upload/confirm`,
    JSON.stringify({ sessionId: sessionId ?? mediaId }),
    { headers: authHeaders(token) },
  );

  confirmSuccessRate.add([200, 202].includes(confirmRes.status));
  check(confirmRes, {
    'upload confirm: 200/202': (r) => [200, 202].includes(r.status),
  });

  // ── 4. Poll for processed media (CDN propagation check) ───────────────────
  if (mediaId && confirmRes.status === 200) {
    let cdnPropagated = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      sleep(2);
      const statusRes = http.get(
        `${BASE_URL}/api/v1/media/${mediaId}/status`,
        { headers: authHeaders(token) },
      );
      if (statusRes.status === 200 && statusRes.json('data.status') === 'READY') {
        cdnPropagated = true;
        break;
      }
    }
    check({ cdnPropagated }, { 'CDN propagated within 10s': (v) => v.cdnPropagated });
  }

  sleep(randomInt(3, 8));
}
