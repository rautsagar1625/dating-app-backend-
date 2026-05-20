// ── WebSocket / Socket.IO Concurrency Test ────────────────────────────────────
// Tests 500 concurrent socket connections with active message exchange.
// Run: k6 run load-tests/k6/websocket.js --env BASE_URL=http://localhost:3002

import http from 'k6/http';
import ws   from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, WS_URL, jsonHeaders, randomChoice, randomInt, TEST_USERS } from './config.js';

const messageDeliveryLatency = new Trend('message_delivery_latency_ms', true);
const connectionErrors        = new Counter('ws_connection_errors');
const unexpectedDisconnects   = new Counter('ws_unexpected_disconnects');
const messagesSent            = new Counter('ws_messages_sent');
const messagesReceived        = new Counter('ws_messages_received');
const deliverySuccessRate     = new Rate('ws_delivery_success');

export const options = {
  stages: [
    { duration: '2m',  target: 500 },
    { duration: '5m',  target: 500 },
    { duration: '1m',  target: 0   },
  ],
  thresholds: {
    'message_delivery_latency_ms': ['p(95)<2000'],
    'ws_delivery_success':         ['rate>0.98'],
    'ws_connection_errors':        ['count<50'],
  },
};

export function setup() {
  // Pre-login to get a token for socket auth
  const user = randomChoice(TEST_USERS);
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: jsonHeaders() },
  );
  if (res.status !== 200) return { token: null };
  return { token: res.json('data.accessToken') };
}

export default function (data) {
  // Each VU: login then connect socket
  const user = randomChoice(TEST_USERS);
  const loginRes = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: jsonHeaders() },
  );

  if (loginRes.status !== 200) {
    connectionErrors.add(1);
    sleep(2);
    return;
  }

  const token = loginRes.json('data.accessToken');
  const userId = loginRes.json('data.user.id');

  // Socket.IO over WebSocket transport
  // Note: Socket.IO starts with HTTP polling then upgrades; simulate WS directly
  const wsUrl = `${WS_URL.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket&token=${token}`;

  const res = ws.connect(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  }, function (socket) {
    const pendingMessages = new Map(); // msgId → sentAt

    socket.on('open', () => {
      // Socket.IO handshake
      socket.send('40'); // Socket.IO connect packet

      // Join user room
      socket.send(JSON.stringify(['join', { userId }]));
    });

    socket.on('message', (data) => {
      // Parse Socket.IO packet
      try {
        if (data.startsWith('42')) {
          const payload = JSON.parse(data.slice(2));
          const event = payload[0];
          const body  = payload[1];

          if (event === 'new_message' && body?.clientTempId) {
            const sentAt = pendingMessages.get(body.clientTempId);
            if (sentAt) {
              messageDeliveryLatency.add(Date.now() - sentAt);
              pendingMessages.delete(body.clientTempId);
              messagesReceived.add(1);
              deliverySuccessRate.add(true);
            }
          }

          if (event === 'match') {
            // Acknowledge match
            socket.send(JSON.stringify(['ack_match', { matchId: body?.matchId }]));
          }
        }
      } catch { /* ignore parse errors */ }
    });

    socket.on('error', () => {
      connectionErrors.add(1);
    });

    socket.on('close', (code) => {
      if (code !== 1000 && code !== 1001) {
        unexpectedDisconnects.add(1);
        deliverySuccessRate.add(false);
      }
    });

    // Send messages at random intervals throughout the connection lifetime
    const sendInterval = randomInt(10000, 30000); // 10-30s
    let iterations = 0;
    const maxIterations = 10;

    const sendMessage = () => {
      if (iterations >= maxIterations) return;
      iterations++;

      const clientTempId = `lt_${__VU}_${Date.now()}_${iterations}`;
      const chatId = `loadtest_chat_${randomInt(1, 1000)}`;

      pendingMessages.set(clientTempId, Date.now());
      messagesSent.add(1);

      socket.send(JSON.stringify([
        'send_message',
        {
          chatId,
          clientTempId,
          content:  `Load test message ${iterations} from VU ${__VU}`,
          type:     'TEXT',
        },
      ]));

      // Check if message was delivered (timeout 5s)
      socket.setTimeout(() => {
        if (pendingMessages.has(clientTempId)) {
          pendingMessages.delete(clientTempId);
          deliverySuccessRate.add(false);
        }
      }, 5000);
    };

    socket.setInterval(sendMessage, sendInterval);

    // Keep connection alive for the test duration (~7-8 min)
    socket.setTimeout(() => socket.close(), 7 * 60 * 1000);
  });

  check(res, {
    'ws: connected successfully': (r) => r && r.status === 101,
  });

  sleep(randomInt(1, 3));
}
