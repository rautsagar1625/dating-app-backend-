// ── Conversation Risk Analyzer ────────────────────────────────────────────────
//
// Maintains a rolling risk profile per chat:
//   - Aggregates signals from individual message moderation results
//   - Detects conversation-level patterns invisible at message level:
//     grooming escalation, prolonged solicitation, scam funnel sequences
//   - Propagates participant trust scores into conversation risk
//   - Triggers escalation when conversation-level thresholds are crossed
//
// Called asynchronously from the message moderation worker — never on the
// hot path.

import prisma from '../../prisma.service';
import { convScoreToLevel, type ModerationSignal } from '../../trust/trust.types';
import { getTrustScore } from '../../trust/trust.score';
import { logger } from '../../../observability/logger';
import { captureException } from '../../../observability/sentry';
import {
  moderationConvEscalationTotal,
} from '../../../observability/metrics';

// Signal type → rolling counter field mapping
const SIGNAL_TO_FIELD: Record<string, string> = {
  ESCORT_SOLICITATION: 'escortSignals',
  CRYPTO_SCAM:         'scamSignals',
  INVESTMENT_SCAM:     'scamSignals',
  SPAM_REPETITION:     'spamMessages',
  SPAM_BULK:           'spamMessages',
  HARASSMENT:          'harassSignals',
  TOXIC_LANGUAGE:      'harassSignals',
  GROOMING_PATTERN:    'toxicMessages',
  MANIPULATION_PATTERN: 'toxicMessages',
  CONTACT_EXTRACTION:  'contactExtracts',
};

// ── Conversation-level pattern detection ──────────────────────────────────────
//
// Patterns that require looking at accumulated state across multiple messages.

interface ConvPattern {
  name:    string;
  detect:  (profile: { escortSignals: number; scamSignals: number; spamMessages: number; contactExtracts: number; harassSignals: number; toxicMessages: number }) => boolean;
  boost:   number;  // additional risk score boost when detected
}

const CONVERSATION_PATTERNS: ConvPattern[] = [
  {
    name:   'ESCORT_FUNNEL',          // solicitation + contact push
    detect: (p) => p.escortSignals >= 2 && p.contactExtracts >= 1,
    boost:  25,
  },
  {
    name:   'SCAM_CONVERSATION',      // multiple scam signals
    detect: (p) => p.scamSignals >= 2,
    boost:  20,
  },
  {
    name:   'GROOMING_ESCALATION',    // manipulation + contact extraction
    detect: (p) => p.toxicMessages >= 2 && p.contactExtracts >= 1,
    boost:  30,
  },
  {
    name:   'HARASSMENT_CAMPAIGN',    // sustained harassment
    detect: (p) => p.harassSignals >= 3,
    boost:  20,
  },
  {
    name:   'OFF_PLATFORM_PUSH',      // repeated contact extraction attempts
    detect: (p) => p.contactExtracts >= 3,
    boost:  15,
  },
];

// ── Main update function ──────────────────────────────────────────────────────

export async function updateConversationRisk(
  chatId:   string,
  userId:   string,  // the message sender
  signals:  ModerationSignal[],
): Promise<void> {
  try {
    // Fetch or create the profile
    const existing = await prisma.conversationRiskProfile.findUnique({
      where: { chatId },
    });

    // Get participant trust scores for risk propagation
    const chat = await prisma.chat.findUnique({
      where:  { id: chatId },
      select: { user1Id: true, user2Id: true },
    });
    if (!chat) return;

    const [initiatorTs, recipientTs] = await Promise.all([
      getTrustScore(chat.user1Id),
      getTrustScore(chat.user2Id),
    ]);

    // Build increments from incoming signals
    const increments: Record<string, number> = {};
    for (const signal of signals) {
      const field = SIGNAL_TO_FIELD[signal.type];
      if (field) {
        increments[field] = (increments[field] ?? 0) + 1;
      }
    }

    // Upsert the profile
    const profile = await prisma.conversationRiskProfile.upsert({
      where:  { chatId },
      create: {
        chatId,
        initiatorRisk: 100 - initiatorTs.score,
        recipientRisk: 100 - recipientTs.score,
        lastSignalAt:  signals.length > 0 ? new Date() : undefined,
        ...Object.fromEntries(Object.entries(increments).map(([k, v]) => [k, v])),
      },
      update: {
        initiatorRisk: 100 - initiatorTs.score,
        recipientRisk: 100 - recipientTs.score,
        ...(signals.length > 0 ? { lastSignalAt: new Date() } : {}),
        ...Object.fromEntries(
          Object.entries(increments).map(([k, v]) => [k, { increment: v }]),
        ),
      },
    });

    // Detect conversation-level patterns and compute risk
    const detectedPatterns: string[] = [];
    let patternBoost = 0;
    for (const pattern of CONVERSATION_PATTERNS) {
      if (pattern.detect(profile)) {
        detectedPatterns.push(pattern.name);
        patternBoost += pattern.boost;
      }
    }

    // Risk score: base from signal counts + pattern boosts + participant risk propagation
    const signalBase = Math.min(
      (profile.escortSignals  * 8) +
      (profile.scamSignals    * 8) +
      (profile.harassSignals  * 6) +
      (profile.toxicMessages  * 5) +
      (profile.contactExtracts * 5) +
      (profile.spamMessages   * 3),
      60,
    );

    // High-risk participant propagation: if sender has low trust, boost conv risk
    const participantBoost = Math.round(
      ((100 - initiatorTs.score) + (100 - recipientTs.score)) / 20
    );

    const newRiskScore = Math.min(signalBase + patternBoost + participantBoost, 100);
    const newRiskLevel = convScoreToLevel(newRiskScore);

    await prisma.conversationRiskProfile.update({
      where: { chatId },
      data:  { riskScore: newRiskScore, riskLevel: newRiskLevel },
    });

    // Escalate if crossing HIGH threshold for the first time
    if (newRiskScore >= 60 && !existing?.escalatedAt && detectedPatterns.length > 0) {
      await prisma.conversationRiskProfile.update({
        where: { chatId },
        data:  { escalatedAt: new Date() },
      });

      // Create a moderation event for the conversation
      await prisma.moderationEvent.create({
        data: {
          sourceType:   'CONVERSATION',
          sourceId:     chatId,
          userId,
          triggerType:  'ASYNC_ML',
          triggerReason: detectedPatterns[0],
          riskScore:    newRiskScore,
          decision:     'ESCALATED',
        },
      });

      moderationConvEscalationTotal.inc({ pattern: detectedPatterns[0] });
      logger.warn({ chatId, riskScore: newRiskScore, patterns: detectedPatterns }, 'conversation escalated');
    }
  } catch (err) {
    logger.error({ err, chatId }, 'conversation risk update failed');
    captureException(err as Error, { chatId });
  }
}

// ── Conversation risk summary (for admin UI) ──────────────────────────────────

export async function getHighRiskConversations(limit = 50) {
  return prisma.conversationRiskProfile.findMany({
    where: { riskLevel: { in: ['HIGH', 'CRITICAL'] } },
    orderBy: { riskScore: 'desc' },
    take: limit,
    include: {
      chat: {
        select: {
          id: true,
          user1: { select: { id: true, email: true, profile: { select: { username: true } } } },
          user2: { select: { id: true, email: true, profile: { select: { username: true } } } },
        },
      },
    },
  });
}
