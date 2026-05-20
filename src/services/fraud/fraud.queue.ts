import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../notification.queue';
import { evaluateDevice } from './risk-engine';
import { applyAutomatedEnforcement, expireStaleEnforcements } from './enforcement.service';
import { ClientFingerprint } from './fraud.types';
import { queueLogger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';

// ── Job types ─────────────────────────────────────────────────────────────────

export interface EvaluateDeviceJob {
  userId: string;
  fingerprint: ClientFingerprint;
  rawIp: string;
}

export interface BehavioralEvalJob {
  userId: string;
  signal: 'SPAM' | 'BOT';
  score: number;
  deviceFpId: string;
}

// ── Queue ─────────────────────────────────────────────────────────────────────

export const fraudQueue = new Queue<EvaluateDeviceJob | BehavioralEvalJob>('fraud', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

// Deduplication: one evaluation per device per 30s (burst suppression)
export async function enqueueDeviceEvaluation(
  userId: string,
  fingerprint: ClientFingerprint,
  rawIp: string,
): Promise<void> {
  const jobId = `device-eval:${fingerprint.deviceId}`;
  await fraudQueue.add(
    'evaluate-device',
    { userId, fingerprint, rawIp },
    { jobId, delay: 500 },   // slight delay to coalesce rapid logins
  ).catch(() => {}); // fire-and-forget
}

export async function enqueueBehavioralSignal(
  userId: string,
  signal: 'SPAM' | 'BOT',
  score: number,
  deviceFpId: string,
): Promise<void> {
  const jobId = `behavioral:${userId}:${signal}`;
  await fraudQueue.add(
    'behavioral-signal',
    { userId, signal, score, deviceFpId },
    { jobId, delay: 1000 },
  ).catch(() => {});
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const fraudWorker = new Worker<EvaluateDeviceJob | BehavioralEvalJob>(
  'fraud',
  async (job: Job) => {
    const log = queueLogger('fraud', job.id);

    if (job.name === 'evaluate-device') {
      const data = job.data as EvaluateDeviceJob;
      log.info({ userId: data.userId }, 'evaluating device fingerprint');

      const result = await evaluateDevice(data.userId, data.fingerprint, data.rawIp);

      if (result.enforcement && result.enforcement !== 'WARN') {
        await applyAutomatedEnforcement(
          data.userId,
          result.deviceFpId,
          result.riskScore,
          result.signals,
        );
      }

      log.info(
        { userId: data.userId, riskScore: result.riskScore, riskLevel: result.riskLevel, enforcement: result.enforcement },
        'device evaluation complete',
      );
      return result;
    }

    if (job.name === 'behavioral-signal') {
      const data = job.data as BehavioralEvalJob;
      log.info({ userId: data.userId, signal: data.signal }, 'processing behavioral signal');

      if (data.score >= 40) {
        await applyAutomatedEnforcement(data.userId, data.deviceFpId, data.score, [data.signal]);
      }
    }
  },
  { connection: redisConnection, concurrency: 10 },
);

fraudWorker.on('failed', (job, err) => {
  const log = queueLogger('fraud', job?.id);
  log.error({ err: err.message, jobData: job?.data }, 'fraud job failed');
  captureException(err, { jobId: job?.id, jobName: job?.name });
});

// ── Cleanup cron (piggyback on the existing scheduleCleanup pattern) ──────────

const cleanupQueue = new Queue('fraud-maintenance', { connection: redisConnection });

export const scheduleFraudMaintenance = async (): Promise<void> => {
  await cleanupQueue.add('expire-enforcements', {}, {
    repeat: { pattern: '0 * * * *' },  // hourly
    jobId: 'expire-enforcements',
  });

  new Worker('fraud-maintenance', async () => {
    await expireStaleEnforcements();
  }, { connection: redisConnection });
};
