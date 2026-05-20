// ── Queue Monitor ──────────────────────────────────────────────────────────────
//
// Provides admin-facing queue operations:
//   - get stats (depth, active, failed, etc.)
//   - list failed jobs with error details
//   - retry individual or bulk failed jobs
//   - pause / resume a queue
//   - drain a queue (remove all waiting jobs)

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  mediaProcessQueue,
  mediaModerateQueue,
  mediaCleanupQueue,
} from '../media/media.queue';
import { fraudQueue } from '../fraud/fraud.queue';
import { analyticsQueue } from './analytics.aggregator';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
});
connection.connect().catch(() => {});

export const KNOWN_QUEUES: Record<string, Queue> = {
  'media-process':  mediaProcessQueue,
  'media-moderate': mediaModerateQueue,
  'media-cleanup':  mediaCleanupQueue,
  'fraud':          fraudQueue,
  'analytics-agg':  analyticsQueue,
};

export function getQueue(name: string): Queue | null {
  return KNOWN_QUEUES[name] ?? null;
}

export interface FailedJobSummary {
  id:           string;
  name:         string;
  data:         unknown;
  failedReason: string;
  attemptsMade: number;
  timestamp:    number;
}

export async function getFailedJobs(queueName: string, limit = 20): Promise<FailedJobSummary[]> {
  const queue = getQueue(queueName);
  if (!queue) throw Object.assign(new Error(`Unknown queue: ${queueName}`), { statusCode: 404 });

  const jobs = await queue.getFailed(0, limit - 1);
  return jobs.map((j) => ({
    id:           j.id ?? '',
    name:         j.name,
    data:         j.data,
    failedReason: j.failedReason ?? 'unknown',
    attemptsMade: j.attemptsMade,
    timestamp:    j.timestamp,
  }));
}

export async function retryFailedJob(queueName: string, jobId: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) throw Object.assign(new Error(`Unknown queue: ${queueName}`), { statusCode: 404 });

  const job = await queue.getJob(jobId);
  if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });

  await job.retry('failed');
}

export async function retryAllFailed(queueName: string): Promise<number> {
  const queue = getQueue(queueName);
  if (!queue) throw Object.assign(new Error(`Unknown queue: ${queueName}`), { statusCode: 404 });

  const jobs = await queue.getFailed(0, 99);
  await Promise.all(jobs.map((j) => j.retry('failed').catch(() => {})));
  return jobs.length;
}

export async function pauseQueue(queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) throw Object.assign(new Error(`Unknown queue: ${queueName}`), { statusCode: 404 });
  await queue.pause();
}

export async function resumeQueue(queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) throw Object.assign(new Error(`Unknown queue: ${queueName}`), { statusCode: 404 });
  await queue.resume();
}

export async function drainQueue(queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue) throw Object.assign(new Error(`Unknown queue: ${queueName}`), { statusCode: 404 });
  await queue.drain();
}
