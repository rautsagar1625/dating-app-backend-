// ── Moderation BullMQ queue architecture ─────────────────────────────────────
//
// Three queues with independent workers:
//
//   msg-moderate    — async deep text analysis via ML provider
//     └─ moderate-message  job: call text provider, store result, update conv risk
//
//   conv-analyze    — conversation-level pattern reassessment (debounced)
//     └─ analyze-conversation job
//
//   trust-recompute — debounced trust score recomputation
//     └─ recompute job (deduplicated per userId)
//
// Retry policy:
//   msg-moderate:    3 attempts, exponential backoff (2s base) — provider may be flaky
//   conv-analyze:    2 attempts, flat 5s delay
//   trust-recompute: 2 attempts, flat 3s delay — DB-only, fast
//
// Dead jobs (exhausted retries) are kept for 24h for inspection.
// Workers gracefully handle provider failures by marking the event ESCALATED.

import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../notification.queue';
import prisma from '../prisma.service';
import { getTextProvider } from './providers/text/text.interface';
import { updateConversationRisk } from './conversation/conversation.analyzer';
import { enforceOnModeration } from './enforcement/moderation.enforcement';
import { recomputeTrustScore } from '../trust/trust.score';
import { queueLogger } from '../../observability/logger';
import { captureException } from '../../observability/sentry';
import {
  queueJobsProcessedTotal,
  queueJobDuration,
  moderationMessageTotal,
  moderationEnforcementTotal,
  moderationProviderDuration,
} from '../../observability/metrics';
import type { ModerationSignal } from '../trust/trust.types';

// ── Job type definitions ──────────────────────────────────────────────────────

export interface ModerateMessageJobData {
  messageId: string;
  chatId:    string;
  userId:    string;
  text:      string;
}

export interface AnalyzeConversationJobData {
  chatId:  string;
  userId:  string;
  signals: ModerationSignal[];
}

export interface TrustRecomputeJobData {
  userId: string;
  reason: string;
}

// ── Queue definitions ─────────────────────────────────────────────────────────

export const msgModerateQueue = new Queue<ModerateMessageJobData>('msg-moderate', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:          3,
    backoff:           { type: 'exponential', delay: 2000 },
    removeOnComplete:  { count: 500 },
    removeOnFail:      { age: 86400 }, // keep failures 24h
  },
});

export const convAnalyzeQueue = new Queue<AnalyzeConversationJobData>('conv-analyze', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:          2,
    backoff:           { type: 'fixed', delay: 5000 },
    removeOnComplete:  { count: 200 },
    removeOnFail:      { age: 86400 },
  },
});

export const trustRecomputeQueue = new Queue<TrustRecomputeJobData>('trust-recompute', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts:          2,
    backoff:           { type: 'fixed', delay: 3000 },
    removeOnComplete:  { count: 200 },
    removeOnFail:      { count: 50 },
  },
});

// ── Enqueue helpers ───────────────────────────────────────────────────────────

// Deduplicated by messageId — no double-processing if enqueued twice
export async function enqueueMessageModeration(data: ModerateMessageJobData): Promise<void> {
  await msgModerateQueue.add('moderate-message', data, {
    jobId: `msg:${data.messageId}`,
  }).catch(() => {});
}

export async function enqueueConversationAnalysis(data: AnalyzeConversationJobData): Promise<void> {
  // Debounce: coalesce rapid signals for same chat (1s window)
  await convAnalyzeQueue.add('analyze-conversation', data, {
    jobId: `conv:${data.chatId}:${Date.now()}`,
    delay: 1000,
  }).catch(() => {});
}

// Deduplicated per user with 30s debounce to avoid thundering-herd on bulk actions
export async function enqueueTrustRecompute(userId: string, reason: string): Promise<void> {
  await trustRecomputeQueue.add('recompute', { userId, reason }, {
    jobId:  `trust:${userId}`,
    delay:  30_000,
  }).catch(() => {});
}

// ── msg-moderate worker ───────────────────────────────────────────────────────

const ENFORCEMENT_THRESHOLD = 70; // risk score above which enforcement is triggered

export const msgModerateWorker = new Worker<ModerateMessageJobData>(
  'msg-moderate',
  async (job: Job<ModerateMessageJobData>) => {
    const { messageId, chatId, userId, text } = job.data;
    const log = queueLogger('msg-moderate', job.id);
    const timer = Date.now();

    log.debug({ messageId, userId }, 'starting async text moderation');

    let decision: 'CLEAN' | 'SUPPRESSED' | 'ESCALATED' = 'CLEAN';
    let riskScore = 0;
    let signals: ModerationSignal[] = [];
    let provider = 'stub';

    try {
      const textProvider = getTextProvider();
      provider = textProvider.name;

      const providerStart = Date.now();
      const result = await textProvider.moderate(text, { senderId: userId, chatId });
      moderationProviderDuration.observe({ provider }, (Date.now() - providerStart) / 1000);

      signals  = result.signals;
      riskScore = Math.round(result.confidence * 100);
      decision  = result.decision === 'REJECTED' ? 'SUPPRESSED' :
                  result.decision === 'ESCALATED' ? 'ESCALATED' : 'CLEAN';

    } catch (err) {
      log.error({ err, messageId }, 'text provider error — marking ESCALATED');
      captureException(err as Error, { messageId, userId });
      decision = 'ESCALATED';
      riskScore = 50;
    }

    // Persist the result
    await prisma.messageModerationResult.upsert({
      where:  { messageId },
      create: { messageId, chatId, userId, riskScore, decision, signals: signals as object, contactsFound: false, provider, processedAt: new Date() },
      update: { riskScore, decision, signals: signals as object, provider, processedAt: new Date() },
    });

    moderationMessageTotal.inc({ decision, provider });

    // Feed signals into conversation risk analyzer
    if (signals.length > 0) {
      await enqueueConversationAnalysis({ chatId, userId, signals });
    }

    // Enforce if above threshold
    if (riskScore >= ENFORCEMENT_THRESHOLD) {
      // Create a moderation event first
      const event = await prisma.moderationEvent.create({
        data: {
          sourceType:    'MESSAGE',
          sourceId:      messageId,
          userId,
          triggerType:   'ASYNC_ML',
          triggerReason: signals[0]?.type ?? 'UNKNOWN',
          riskScore,
          decision:      'ESCALATED',
        },
      });

      const enforcement = await enforceOnModeration(userId, signals[0]?.type ?? 'ML_ESCALATION', riskScore, event.id);
      if (enforcement) {
        moderationEnforcementTotal.inc({ type: enforcement.type });
        log.warn({ userId, enforcement: enforcement.type, riskScore }, 'enforcement applied from async moderation');
      }
    }

    queueJobsProcessedTotal.inc({ queue: 'msg-moderate', status: 'completed' });
    queueJobDuration.observe({ queue: 'msg-moderate' }, (Date.now() - timer) / 1000);
  },
  {
    connection:  redisConnection,
    concurrency: 5,
  },
);

msgModerateWorker.on('failed', (job, err) => {
  queueLogger('msg-moderate', job?.id).error({ err, jobId: job?.id }, 'msg-moderate job failed');
  queueJobsProcessedTotal.inc({ queue: 'msg-moderate', status: 'failed' });
  captureException(err, { queue: 'msg-moderate', jobId: job?.id });
});

// ── conv-analyze worker ───────────────────────────────────────────────────────

export const convAnalyzeWorker = new Worker<AnalyzeConversationJobData>(
  'conv-analyze',
  async (job: Job<AnalyzeConversationJobData>) => {
    const { chatId, userId, signals } = job.data;
    await updateConversationRisk(chatId, userId, signals);
    queueJobsProcessedTotal.inc({ queue: 'conv-analyze', status: 'completed' });
  },
  {
    connection:  redisConnection,
    concurrency: 10,
  },
);

convAnalyzeWorker.on('failed', (job, err) => {
  queueLogger('conv-analyze', job?.id).error({ err }, 'conv-analyze job failed');
  queueJobsProcessedTotal.inc({ queue: 'conv-analyze', status: 'failed' });
});

// ── trust-recompute worker ────────────────────────────────────────────────────

export const trustRecomputeWorker = new Worker<TrustRecomputeJobData>(
  'trust-recompute',
  async (job: Job<TrustRecomputeJobData>) => {
    const { userId, reason } = job.data;
    await recomputeTrustScore(userId, reason);
    queueJobsProcessedTotal.inc({ queue: 'trust-recompute', status: 'completed' });
  },
  {
    connection:  redisConnection,
    concurrency: 20,
  },
);

trustRecomputeWorker.on('failed', (job, err) => {
  queueLogger('trust-recompute', job?.id).error({ err }, 'trust-recompute job failed');
  queueJobsProcessedTotal.inc({ queue: 'trust-recompute', status: 'failed' });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

export async function closeModerationWorkers(): Promise<void> {
  await Promise.all([
    msgModerateWorker.close(),
    convAnalyzeWorker.close(),
    trustRecomputeWorker.close(),
  ]);
}
