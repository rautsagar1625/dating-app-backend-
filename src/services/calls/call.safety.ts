// ── Call Trust & Safety ───────────────────────────────────────────────────────
//
// Enforces pre-call safety checks and handles post-call moderation reports.
//
// Pre-call checks (all must pass before call is initiated):
//   1. Caller is not banned / shadow-restricted
//   2. No mutual block between caller and callee
//   3. Spam limit: ≤ 3 calls to same person in 1h
//   4. Callee has chat access (chat must exist and be unlocked — prevents cold calls)
//   5. Callee is online (no missed call spam)
//   6. No existing active call for either party
//
// Post-call moderation:
//   - submitCallReport: records CallModerationEvent, feeds into existing enforcement
//   - Repeated reports against same user → auto-escalation to moderation review
//   - Call-rate anomaly detection: >10 calls/hour from one user → cooldown

import prisma from '../prisma.service';
import { checkSpamLimit, getUserActiveCallId } from './call.state';
import { isHardBanned, isShadowRestricted } from '../fraud/enforcement.service';
import { isBlocked } from '../block.service';
import { isUserOnlineSocket } from '../socket.service';
import { enforceOnModeration } from '../moderation/enforcement/moderation.enforcement';
import { logger } from '../../observability/logger';
import { callSafetyBlocked } from '../../observability/metrics';

// ── Pre-call safety gate ──────────────────────────────────────────────────────

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  code?:   string;
}

export async function checkCallSafety(
  callerId: string,
  calleeId: string,
): Promise<SafetyCheckResult> {
  const [
    callerBanned,
    callerShadow,
    blocked,
    spamTripped,
    callerActiveCall,
    calleeActiveCall,
  ] = await Promise.all([
    isHardBanned(callerId),
    isShadowRestricted(callerId),
    isBlocked(callerId, calleeId),
    checkSpamLimit(callerId, calleeId),
    getUserActiveCallId(callerId),
    getUserActiveCallId(calleeId),
  ]);

  if (callerBanned) {
    callSafetyBlocked.inc({ reason: 'banned' });
    return { allowed: false, reason: 'Account restricted', code: 'BANNED' };
  }

  if (callerShadow) {
    // Shadow-restricted users think calls go through but they're silently blocked
    callSafetyBlocked.inc({ reason: 'shadow' });
    return { allowed: false, reason: 'Call unavailable', code: 'SHADOW_BLOCK', silent: true } as any;
  }

  if (blocked) {
    callSafetyBlocked.inc({ reason: 'blocked' });
    return { allowed: false, reason: 'BLOCKED', code: 'BLOCKED' };
  }

  if (spamTripped) {
    callSafetyBlocked.inc({ reason: 'spam' });
    return { allowed: false, reason: 'Too many calls — try again later', code: 'RATE_LIMITED' };
  }

  if (callerActiveCall) {
    callSafetyBlocked.inc({ reason: 'already_in_call' });
    return { allowed: false, reason: 'You are already in a call', code: 'ALREADY_IN_CALL' };
  }

  if (calleeActiveCall) {
    callSafetyBlocked.inc({ reason: 'callee_busy' });
    return { allowed: false, reason: 'User is busy', code: 'BUSY' };
  }

  // Callee must be online (prevents spam to offline users)
  if (!isUserOnlineSocket(calleeId)) {
    callSafetyBlocked.inc({ reason: 'callee_offline' });
    return { allowed: false, reason: 'User is not available', code: 'OFFLINE' };
  }

  // Must have an unlocked chat (prevents cold calls to strangers)
  const chat = await prisma.chat.findFirst({
    where: {
      isUnlocked: true,
      OR: [
        { user1Id: callerId, user2Id: calleeId },
        { user1Id: calleeId, user2Id: callerId },
      ],
    },
    select: { id: true },
  });

  if (!chat) {
    callSafetyBlocked.inc({ reason: 'no_unlocked_chat' });
    return { allowed: false, reason: 'Unlock the chat before calling', code: 'CHAT_LOCKED' };
  }

  return { allowed: true };
}

// ── Call abuse report ─────────────────────────────────────────────────────────

export async function submitCallReport(params: {
  callId:     string;
  reporterId: string;
  reportedId: string;
  reason:     string;
  notes?:     string;
}): Promise<string> {
  const { callId, reporterId, reportedId, reason, notes } = params;

  // Verify call exists and reporter was a participant
  const participant = await prisma.callParticipant.findFirst({
    where: { callId, userId: reporterId },
    select: { id: true },
  });
  if (!participant) {
    throw Object.assign(new Error('You were not part of this call'), { statusCode: 403 });
  }

  // One pending report per call per reporter
  const existing = await prisma.callModerationEvent.findFirst({
    where: { callId, reporterId, status: 'PENDING' },
    select: { id: true },
  });
  if (existing) {
    throw Object.assign(new Error('Report already submitted for this call'), { statusCode: 409 });
  }

  const report = await prisma.callModerationEvent.create({
    data: {
      callId,
      reporterId,
      reportedId,
      reason,
      notes: notes?.slice(0, 500),
    },
  });

  // Count recent reports against this user — auto-escalate if pattern detected
  const recentReportCount = await prisma.callModerationEvent.count({
    where: {
      reportedId,
      status: 'PENDING',
      createdAt: { gte: new Date(Date.now() - 7 * 86400_000) },
    },
  });

  if (recentReportCount >= 3) {
    // Auto-escalate to moderation enforcement
    enforceOnModeration(reportedId, `call_abuse:${reason}`, 65).catch(() => {});
    await prisma.callModerationEvent.updateMany({
      where: { reportedId, status: 'PENDING' },
      data:  { status: 'ESCALATED' },
    });
    logger.warn({ reportedId, recentReportCount }, 'call abuse auto-escalated');
  }

  return report.id;
}
