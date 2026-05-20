import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app';
import { getCorsOrigins } from './config/env';
import { verifyToken } from './utils/jwt.util';
import { initSocket, markUserOnline, markUserOffline, isUserOnlineSocket } from './services/socket.service';
import { scheduleCleanup } from './services/notification.queue';
import { scheduleFraudMaintenance } from './services/fraud/fraud.queue';
import { scheduleMediaMaintenance } from './services/media/media.queue';
import { scheduleAnalyticsAggregations } from './services/admin/analytics.aggregator';
import {
  msgModerateWorker,
  convAnalyzeWorker,
  trustRecomputeWorker,
  closeModerationWorkers,
} from './services/moderation/moderation.queue';
import {
  recCandidateGenWorker,
  recSignalAggWorker,
  recRankWorker,
  recSignalDecayWorker,
  scheduleRecCrons,
  closeRecWorkers,
} from './services/recommendation/recommendation.queue';
import { voiceProcessWorker, closeVoiceWorker } from './services/voice/voice.queue';
import { callBillingWorker, closeCallBillingWorker } from './services/calls/call.billing';
import { registerCallHandlers, startRingTimeoutWorker } from './socket/call.signaling';
import {
  paymentWebhookWorker,
  paymentReconcileWorker,
  schedulePaymentReconcile,
  closePaymentWorkers,
} from './services/payments/payment.queue';
import {
  subscriptionWorker,
  scheduleSubscriptionCrons,
  closeSubscriptionWorker,
} from './services/subscriptions/subscription.queue';
import {
  revenueAnalyticsWorker,
  scheduleRevenueAnalyticsCrons,
  closeRevenueAnalyticsWorker,
} from './services/monetization/revenue.analytics';
import { loadAllProviders } from './services/payments/providers/payment.provider.registry';
import prisma from './services/prisma.service';
import { logger, socketLogger } from './observability/logger';
import './services/backup-monitor'; // starts metric refresh interval on boot
import { captureException } from './observability/sentry';
import {
  wsConnectionsGauge,
  wsOnlineUsersGauge,
  wsDisconnectTotal,
  wsReconnectTotal,
  wsMessagesTotal,
} from './observability/metrics';

const PORT = process.env.PORT || 3002;

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: { origin: getCorsOrigins(), methods: ['GET', 'POST'] },
});

initSocket(io);

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string | undefined;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const decoded = verifyToken(token);
    socket.data.userId = decoded.userId;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// Track grace-period timers: when a user disconnects, wait 30s before marking
// them offline. This prevents presence flicker on brief network interruptions.
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

io.on('connection', (socket) => {
  const userId = socket.data.userId as string;
  const log = socketLogger(socket.id, userId);
  socket.join(`user:${userId}`);

  wsConnectionsGauge.inc();

  // Reconnect within grace period — cancel the pending offline timer
  const existing = offlineTimers.get(userId);
  if (existing) {
    clearTimeout(existing);
    offlineTimers.delete(userId);
    wsReconnectTotal.inc();
    log.debug('socket reconnected within grace period');
  }

  const wasOffline = !isUserOnlineSocket(userId);
  markUserOnline(userId);
  wsOnlineUsersGauge.inc();

  if (wasOffline) {
    broadcastPresence(userId, true).catch(() => {});
  }

  deliverPendingMessages(userId).catch(() => {});
  registerCallHandlers(socket, userId, io);
  log.info({ event: 'connect' }, 'socket connected');

  // Track outbound message events for throughput metrics
  const originalEmit = socket.emit.bind(socket);
  socket.emit = function (event: string, ...args: any[]) {
    wsMessagesTotal.inc({ event });
    return originalEmit(event, ...args);
  } as typeof socket.emit;

  socket.on('disconnect', (reason) => {
    wsConnectionsGauge.dec();
    wsDisconnectTotal.inc({ reason });
    log.info({ event: 'disconnect', reason }, 'socket disconnected');

    const room = io.sockets.adapter.rooms.get(`user:${userId}`);
    if (room && room.size > 0) return; // other sockets still connected

    // 30s grace period before broadcasting offline
    const timer = setTimeout(() => {
      offlineTimers.delete(userId);
      markUserOffline(userId);
      wsOnlineUsersGauge.dec();
      broadcastPresence(userId, false).catch(() => {});
    }, 30_000);
    offlineTimers.set(userId, timer);
  });
});

async function broadcastPresence(userId: string, online: boolean): Promise<void> {
  const chats = await prisma.chat.findMany({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { user1Id: true, user2Id: true },
  });
  for (const chat of chats) {
    const partnerId = chat.user1Id === userId ? chat.user2Id : chat.user1Id;
    io.to(`user:${partnerId}`).emit('presence_change', { userId, online });
  }
}

async function deliverPendingMessages(userId: string): Promise<void> {
  const pending = await prisma.message.findMany({
    where: {
      status: 'SENT',
      senderId: { not: userId },
      chat: { OR: [{ user1Id: userId }, { user2Id: userId }] },
    },
    select: { id: true, senderId: true, chatId: true },
  });

  if (pending.length === 0) return;

  const now = new Date();
  const ids = pending.map((m) => m.id);

  await prisma.message.updateMany({
    where: { id: { in: ids } },
    data: { status: 'DELIVERED', deliveredAt: now },
  });

  const bySender = new Map<string, string[]>();
  for (const m of pending) {
    if (!bySender.has(m.senderId)) bySender.set(m.senderId, []);
    bySender.get(m.senderId)!.push(m.id);
  }

  for (const [senderId, messageIds] of bySender) {
    io.to(`user:${senderId}`).emit('messages_delivered', {
      messageIds,
      deliveredAt: now.toISOString(),
    });
  }
}

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'server started');
  scheduleCleanup().catch(() => {});
  scheduleFraudMaintenance().catch(() => {});
  scheduleMediaMaintenance().catch(() => {});
  scheduleAnalyticsAggregations().catch(() => {});

  // Moderation workers
  logger.info(
    { workers: [msgModerateWorker.name, convAnalyzeWorker.name, trustRecomputeWorker.name] },
    'moderation workers started',
  );

  // Recommendation workers
  scheduleRecCrons().catch(() => {});
  logger.info(
    { workers: [recCandidateGenWorker.name, recSignalAggWorker.name, recRankWorker.name, recSignalDecayWorker.name] },
    'recommendation workers started',
  );

  // Voice + call workers
  startRingTimeoutWorker().catch(() => {});
  logger.info(
    { workers: [voiceProcessWorker.name, callBillingWorker.name, 'ring-timeout'] },
    'voice and call workers started',
  );

  // Payment + monetization workers
  loadAllProviders();
  schedulePaymentReconcile().catch(() => {});
  scheduleSubscriptionCrons().catch(() => {});
  scheduleRevenueAnalyticsCrons().catch(() => {});
  logger.info(
    { workers: [paymentWebhookWorker.name, paymentReconcileWorker.name, subscriptionWorker.name, revenueAnalyticsWorker.name] },
    'monetization workers started',
  );
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down workers');
  await Promise.allSettled([
    closeModerationWorkers(),
    closeRecWorkers(),
    closeVoiceWorker(),
    closeCallBillingWorker(),
    closePaymentWorkers(),
    closeSubscriptionWorker(),
    closeRevenueAnalyticsWorker(),
  ]);
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandledRejection');
  captureException(reason, { event: 'unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'uncaughtException');
  captureException(err, { event: 'uncaughtException' });
  process.nextTick(() => process.exit(1));
});
