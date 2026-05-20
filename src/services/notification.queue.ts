import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import prisma from './prisma.service';
import { emitToUser } from './socket.service';
import { sendPushToUser } from './push.service';
import { isBlocked } from './block.service';
import type { NotificationType } from './notification.service';
import { queueLogger } from '../observability/logger';
import { captureException } from '../observability/sentry';
import {
  queueJobsProcessedTotal,
  queueJobDuration,
  queueDepthGauge,
  queueFailedJobsTotal,
  notificationsSentTotal,
} from '../observability/metrics';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
});

const PUSH_TITLES: Record<NotificationType, string> = {
  LIKE:    'New Like 💜',
  MESSAGE: 'New Message 💬',
  VISIT:   'New Visitor 👀',
};

const PUSH_BODIES: Record<NotificationType, string> = {
  LIKE:    'Someone liked your profile',
  MESSAGE: 'You have a new message',
  VISIT:   'Someone visited your profile',
};

export interface NotificationJobData {
  userId: string;
  type: NotificationType;
  referenceId: string;
}

export const notificationQueue = new Queue<NotificationJobData>('notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
});

// Deduplication window: collapse repeated events for the same (userId, type, referenceId)
// within 30s into a single job. Prevents notification spam during rapid interactions.
export const enqueueNotification = async (
  userId: string,
  type: NotificationType,
  referenceId: string,
): Promise<void> => {
  const jobId = `${userId}:${type}:${referenceId}`;
  await notificationQueue.add('send', { userId, type, referenceId }, {
    jobId,        // deduplicates: adding same jobId while it's pending is a no-op
    delay: 2000,  // 2s debounce window — collapses burst clicks into one notification
  });
};

// Worker processes jobs one at a time per Redis connection
export const notificationWorker = new Worker<NotificationJobData>(
  'notifications',
  async (job: Job<NotificationJobData>) => {
    const log = queueLogger('notifications', job.id);
    const start = Date.now();

    const { userId, type, referenceId } = job.data;

    if (await isBlocked(userId, referenceId)) {
      log.debug({ userId, type }, 'notification skipped — blocked');
      return;
    }

    const notification = await prisma.notification.upsert({
      where:  { userId_type_referenceId: { userId, type, referenceId } },
      update: { isRead: false, createdAt: new Date() },
      create: { userId, type, referenceId },
    });

    const unreadCount = await prisma.notification.count({
      where: { userId, isRead: false },
    });

    emitToUser(userId, 'new_notification', {
      id:          notification.id,
      type:        notification.type,
      referenceId: notification.referenceId,
      isRead:      false,
      createdAt:   notification.createdAt.toISOString(),
      unreadCount,
    });

    await sendPushToUser(userId, PUSH_TITLES[type], PUSH_BODIES[type], {
      type,
      referenceId,
      notificationId: notification.id,
    });

    const durationSec = (Date.now() - start) / 1000;
    queueJobDuration.observe({ queue: 'notifications' }, durationSec);
    queueJobsProcessedTotal.inc({ queue: 'notifications', status: 'completed' });
    notificationsSentTotal.inc({ type });
    log.info({ userId, type, durationMs: Math.round(durationSec * 1000) }, 'notification delivered');
  },
  {
    connection: redisConnection,
    concurrency: 5,
  },
);

notificationWorker.on('failed', (job, err) => {
  const log = queueLogger('notifications', job?.id);
  const isExhausted = job?.attemptsMade === job?.opts?.attempts;

  log.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'notification job failed');
  captureException(err, { jobId: job?.id, jobData: job?.data });

  queueJobsProcessedTotal.inc({ queue: 'notifications', status: 'failed' });
  if (isExhausted) {
    queueFailedJobsTotal.inc({ queue: 'notifications' });
  }
});

// Poll queue depth every 30s so Prometheus can scrape it
setInterval(async () => {
  try {
    const waiting = await notificationQueue.getWaitingCount();
    queueDepthGauge.set({ queue: 'notifications' }, waiting);
  } catch {
    // non-critical — ignore
  }
}, 30_000);

// Cleanup job: remove notifications older than 90 days (runs daily via queue scheduler)
export const scheduleCleanup = async (): Promise<void> => {
  const cleanupQueue = new Queue('notification-cleanup', { connection: redisConnection });
  await cleanupQueue.add(
    'cleanup',
    {},
    {
      repeat: { pattern: '0 3 * * *' }, // 3 AM daily
      jobId: 'daily-notification-cleanup',
    },
  );

  new Worker(
    'notification-cleanup',
    async () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const { count } = await prisma.notification.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      const log = queueLogger('notification-cleanup');
      log.info({ deletedCount: count }, 'old notifications cleaned up');
    },
    { connection: redisConnection },
  );
};
