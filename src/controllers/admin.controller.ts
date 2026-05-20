import { Request, Response, NextFunction } from 'express';
import prisma from '../services/prisma.service';
import { invalidateBanCache } from '../middleware/auth.middleware';

// Safe req.query cast — Express query params are string | string[] | ParsedQs | ParsedQs[]
// For all admin endpoints we only accept single string values.
const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
import { auditLog } from '../middleware/admin.middleware';
import {
  getLiveDashboard,
  getMetricTimeSeries,
  getUserInvestigationProfile,
  getRetentionData,
  getRevenueTimeSeries,
  getTopSpenders,
  searchByRequestId,
  getUserActivityTimeline,
  getQueueStats,
} from '../services/admin/dashboard.service';
import {
  getFailedJobs,
  retryFailedJob,
  retryAllFailed,
  pauseQueue,
  resumeQueue,
  drainQueue,
  KNOWN_QUEUES,
} from '../services/admin/queue.monitor';
import {
  triggerAggregationForDate,
} from '../services/admin/analytics.aggregator';

// ── Pagination helper ──────────────────────────────────────────────────────────
function paginate(query: Request['query']) {
  const page     = Math.max(1, parseInt(qs(query.page)     ?? '1',  10));
  const pageSize = Math.min(100, Math.max(1, parseInt(qs(query.pageSize) ?? qs(query.limit) ?? '20', 10)));
  const skip     = (page - 1) * pageSize;
  return { page, pageSize, skip };
}

function pageResponse(data: unknown[], total: number, page: number, pageSize: number) {
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

// ── Live dashboard ─────────────────────────────────────────────────────────────

// GET /api/admin/dashboard
export const getDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = await getLiveDashboard();
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/dashboard/timeseries?metric=DAU&days=30
export const getTimeSeries = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const metric = qs(req.query.metric) ?? 'DAU';
    const days   = Math.min(90, parseInt(qs(req.query.days) ?? '30', 10));
    const data   = await getMetricTimeSeries(metric, days);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── Overview ───────────────────────────────────────────────────────────────────

// GET /api/admin/overview/stats
export const getOverviewStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const now   = new Date();
    const d1    = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d30   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d60   = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [
      totalUsers,
      dauNow,
      dauPrev,
      revMtdRows,
      revPrevRows,
      activeSubs,
      activeSubsPrev,
      openReports,
      matchesToday,
      fraudAlerts,
      newUsersNow,
      newUsersPrev,
      convExposures,
      convConverted,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { lastSeen: { gte: d1 } } }),
      prisma.user.count({ where: { lastSeen: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000), lt: d1 } } }),
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: d30 } }, _sum: { amountUsd: true } }),
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: d60, lt: d30 } }, _sum: { amountUsd: true } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', createdAt: { lt: d30 } } }),
      prisma.report.count({ where: { isResolved: false } }),
      prisma.like.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.fraudCase.count({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } } }),
      prisma.user.count({ where: { createdAt: { gte: d30 } } }),
      prisma.user.count({ where: { createdAt: { gte: d60, lt: d30 } } }),
      prisma.offerExposure.count({ where: { shownAt: { gte: d30 } } }).catch(() => 0),
      prisma.offerExposure.count({ where: { shownAt: { gte: d30 }, convertedAt: { not: null } } }).catch(() => 0),
    ]);

    const revMtd   = Number(revMtdRows._sum.amountUsd  ?? 0);
    const revPrev  = Number(revPrevRows._sum.amountUsd ?? 0);

    const pctChange = (now_: number, prev: number) =>
      prev === 0 ? 0 : Math.round(((now_ - prev) / prev) * 100 * 10) / 10;

    const subGrowth = activeSubs - activeSubsPrev;

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        dau:               dauNow,
        revenueMtd:        revMtd,
        activeSubscriptions: activeSubs,
        openReports,
        matchesToday,
        fraudAlerts,
        conversionRate:    convExposures > 0 ? Math.round((convConverted / convExposures) * 10000) / 100 : 0,
        userGrowth:        newUsersNow,
        dauChange:         pctChange(dauNow, dauPrev),
        revenueChange:     pctChange(revMtd, revPrev),
        subGrowth,
        conversionChange:  0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/overview/charts?days=30
export const getOverviewCharts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days  = Math.min(90, parseInt(qs(req.query.days) ?? '30', 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [userSnapshots, revenueSnapshots] = await Promise.all([
      prisma.dashboardMetricSnapshot.findMany({
        where: { metric: { in: ['NEW_USERS', 'DAU'] }, granularity: 'DAILY', periodStart: { gte: since } },
        orderBy: { periodStart: 'asc' },
      }),
      prisma.revenueSnapshot.findMany({
        where: { granularity: 'DAY', periodStart: { gte: since } },
        orderBy: { periodStart: 'asc' },
      }),
    ]);

    // Build date-indexed maps
    const userMap: Record<string, { registrations: number; dau: number }> = {};
    for (const row of userSnapshots) {
      const date = row.periodStart.toISOString().slice(0, 10);
      if (!userMap[date]) userMap[date] = { registrations: 0, dau: 0 };
      if (row.metric === 'NEW_USERS') userMap[date].registrations = row.value;
      if (row.metric === 'DAU')       userMap[date].dau            = row.value;
    }

    const userGrowth = Object.entries(userMap).map(([date, v]) => ({ date, ...v }));

    const revenue = revenueSnapshots.map((r) => ({
      date:          r.periodStart.toISOString().slice(0, 10),
      subscriptions: Number(r.subscriptionRev),
      boosts:        Number(r.boostRev),
    }));

    res.status(200).json({ success: true, data: { userGrowth, revenue } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/overview/alerts?limit=5
export const getOverviewAlerts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(50, parseInt(qs(req.query.limit) ?? '5', 10));

    const [fraudCases, openReports, failedMedia] = await Promise.all([
      prisma.fraudCase.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: Math.ceil(limit / 3),
        select: { id: true, userId: true, riskScore: true, priority: true, createdAt: true },
      }),
      prisma.report.findMany({
        where: { isResolved: false },
        orderBy: { createdAt: 'desc' },
        take: Math.ceil(limit / 3),
        select: { id: true, reason: true, createdAt: true },
      }),
      prisma.mediaAsset.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: Math.ceil(limit / 3),
        select: { id: true, mediaType: true, createdAt: true },
      }),
    ]);

    const alerts = [
      ...fraudCases.map((c) => ({
        id:        c.id,
        type:      'FRAUD',
        message:   `Fraud case: risk score ${c.riskScore}`,
        severity:  c.priority === 'CRITICAL' ? 'critical' : c.priority === 'HIGH' ? 'high' : 'medium',
        createdAt: c.createdAt,
      })),
      ...openReports.map((r) => ({
        id:        r.id,
        type:      'REPORT',
        message:   `Open report: ${r.reason}`,
        severity:  'medium',
        createdAt: r.createdAt,
      })),
      ...failedMedia.map((m) => ({
        id:        m.id,
        type:      'MEDIA',
        message:   `Media processing failed: ${m.mediaType}`,
        severity:  'low',
        createdAt: m.createdAt,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    res.status(200).json({ success: true, data: { alerts } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/overview/queues
export const getOverviewQueues = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stats = await getQueueStats();
    const result: Record<string, { waiting: number; active: number; failed: number }> = {};
    for (const s of stats) {
      result[s.name] = { waiting: s.waiting, active: s.active, failed: s.failed };
    }
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ── User management ────────────────────────────────────────────────────────────

// GET /api/admin/users
export const getUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const search  = qs(req.query.search);
    const status  = qs(req.query.status);
    const sortBy  = qs(req.query.sortBy)    ?? 'createdAt';
    const sortOrd = qs(req.query.sortOrder) ?? 'desc';
    // Legacy params kept for backward compat
    const banned  = qs(req.query.banned);
    const role    = qs(req.query.role);

    const where: any = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { profile: { username: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status === 'BANNED' || banned === 'true')  where.isBanned = true;
    if (status === 'ACTIVE' || banned === 'false') where.isBanned = false;
    if (role) where.role = role;

    const allowedSort: Record<string, any> = {
      createdAt:    { createdAt: sortOrd },
      lastActiveAt: { lastSeen:  sortOrd },
      email:        { email:     sortOrd },
    };
    const orderBy = allowedSort[sortBy] ?? { createdAt: 'desc' };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: {
          profile:      { select: { username: true, age: true, location: true } },
          wallet:       { select: { balance: true } },
          _count:       { select: { reportsRecv: true, messages: true } },
          spenderSegment: { select: { segment: true, totalSpend: true } },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    // Enrich with risk profiles in batch
    const userIds = users.map((u) => u.id);
    const riskProfiles = await prisma.userRiskProfile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, riskScore: true, reportCount: true, isSoftBanned: true },
    }).catch(() => [] as any[]);
    const riskMap = Object.fromEntries(riskProfiles.map((r: any) => [r.userId, r]));

    res.status(200).json({
      success: true,
      data: pageResponse(
        users.map((u) => {
          const rp = riskMap[u.id];
          return {
            id:                 u.id,
            email:              u.email,
            name:               u.profile?.username ?? u.email ?? u.id,
            status:             u.isBanned ? 'BANNED' : 'ACTIVE',
            role:               u.role,
            trustScore:         rp ? Math.max(0, 100 - rp.riskScore) : 100,
            riskScore:          rp?.riskScore ?? 0,
            verificationStatus: 'UNVERIFIED',
            deviceCount:        0,
            reportCount:        rp?.reportCount ?? u._count.reportsRecv,
            warningCount:       0,
            isOnline:           u.lastSeen ? (Date.now() - new Date(u.lastSeen).getTime()) < 5 * 60 * 1000 : false,
            createdAt:          u.createdAt,
            lastActiveAt:       u.lastSeen,
            profile:            u.profile,
            walletBalance:      u.wallet?.balance ?? 0,
            messageCount:       u._count.messages,
            segment:            u.spenderSegment?.segment ?? 'FREE',
          };
        }),
        total, page, pageSize,
      ),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:id
export const getUserDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const profile = await getUserInvestigationProfile(req.params.id as string);
    if (!profile) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:userId/investigation  (legacy alias)
export const getUserInvestigation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const profile = await getUserInvestigationProfile(req.params.userId as string);
    if (!profile) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:id/timeline
export const getUserTimelineNew = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.id as string;
    const limit  = Math.min(200, parseInt(qs(req.query.limit) ?? '50', 10));

    const [analyticsEvents, auditLogs, moderationEvents, fraudSignals] = await Promise.all([
      prisma.analyticsEvent.findMany({
        where: { userId },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        select: { id: true, event: true, occurredAt: true },
      }).catch(() => [] as any[]),
      prisma.adminAuditLog.findMany({
        where: { targetId: userId, targetType: 'USER' },
        orderBy: { createdAt: 'desc' },
        take: Math.ceil(limit / 3),
        select: { id: true, action: true, createdAt: true, metadata: true },
      }).catch(() => [] as any[]),
      prisma.moderationEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: Math.ceil(limit / 3),
        select: { id: true, triggerReason: true, decision: true, createdAt: true },
      }).catch(() => [] as any[]),
      prisma.fraudSignal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: Math.ceil(limit / 3),
        select: { id: true, signalType: true, severity: true, createdAt: true },
      }).catch(() => [] as any[]),
    ]);

    const events = [
      ...analyticsEvents.map((e: any) => ({ id: e.id, type: 'ANALYTICS', description: e.event, createdAt: e.occurredAt })),
      ...auditLogs.map((e: any) => ({ id: e.id, type: 'ADMIN_ACTION', description: e.action, createdAt: e.createdAt })),
      ...moderationEvents.map((e: any) => ({ id: e.id, type: 'MODERATION', description: `${e.triggerReason}: ${e.decision}`, createdAt: e.createdAt })),
      ...fraudSignals.map((e: any) => ({ id: e.id, type: 'FRAUD_SIGNAL', description: `${e.signalType} [${e.severity}]`, createdAt: e.createdAt })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    res.status(200).json({ success: true, data: { events } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:userId/timeline (legacy)
export const getUserTimeline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const hours = Math.min(168, parseInt(qs(req.query.hours) ?? '24', 10));
    const data  = await getUserActivityTimeline(req.params.userId as string, hours);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:id/devices
export const getUserDevices = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.id as string;

    // DeviceFingerprint links to users via linkedUserIds array
    const devices = await prisma.deviceFingerprint.findMany({
      where: { linkedUserIds: { has: userId } },
      orderBy: { lastSeenAt: 'desc' },
      take: 20,
      select: {
        id: true, brand: true, model: true, osName: true, osVersion: true,
        isEmulator: true, isRooted: true, riskScore: true, riskLevel: true,
        recentIpHashes: true, lastSeenAt: true, firstSeenAt: true,
      },
    }).catch(() => [] as any[]);

    // Also fetch push tokens as a proxy for device count
    const pushTokens = await prisma.pushToken.findMany({
      where: { userId },
      select: { id: true, token: true, createdAt: true, updatedAt: true },
    }).catch(() => [] as any[]);

    const deviceList = devices.length > 0
      ? devices.map((d: any) => ({
          id:      d.id,
          type:    d.brand ?? 'Unknown',
          os:      `${d.osName ?? ''} ${d.osVersion ?? ''}`.trim() || 'Unknown',
          ip:      d.recentIpHashes?.[0] ?? 'hidden',
          lastSeen: d.lastSeenAt,
          isEmulator: d.isEmulator,
          isRooted:   d.isRooted,
          riskScore:  d.riskScore,
          riskLevel:  d.riskLevel,
        }))
      : pushTokens.map((t: any) => ({
          id:      t.id,
          type:    'Mobile',
          os:      'Unknown',
          ip:      'hidden',
          lastSeen: t.updatedAt,
        }));

    res.status(200).json({ success: true, data: { devices: deviceList } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:id/payments
export const getUserPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const userId = req.params.id as string;

    const [sessions, total] = await Promise.all([
      prisma.paymentSession.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.paymentSession.count({ where: { userId } }),
    ]);

    res.status(200).json({ success: true, data: pageResponse(sessions, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users/:id/enforcements
export const getUserEnforcements = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.id as string;
    const enforcements = await prisma.fraudEnforcementAction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({ success: true, data: enforcements });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/users/:id/ban
export const banUserNew = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId = req.user!.userId;
    const userId  = req.params.id as string;
    const { reason } = req.body;

    if (adminId === userId) {
      res.status(400).json({ success: false, message: 'Cannot ban yourself' });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!target) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    if (target.role === 'admin') {
      res.status(403).json({ success: false, message: 'Cannot ban another admin' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data:  { isBanned: true },
      select: { id: true, isBanned: true },
    });

    await invalidateBanCache(userId);

    // Create enforcement record
    await prisma.fraudEnforcementAction.create({
      data: {
        userId,
        actionType: 'HARD_BAN',
        reason:     reason ?? 'Admin ban',
        actorId:    adminId,
        isActive:   true,
      },
    }).catch(() => {});

    auditLog(adminId, 'BAN_USER', { targetType: 'USER', targetId: userId, metadata: { reason }, req });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/users/:id/ban
export const unbanUserNew = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId = req.user!.userId;
    const userId  = req.params.id as string;

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data:  { isBanned: false },
      select: { id: true, isBanned: true },
    });

    await invalidateBanCache(userId);

    // Revoke active hard-ban enforcements
    await prisma.fraudEnforcementAction.updateMany({
      where: { userId, actionType: 'HARD_BAN', isActive: true },
      data:  { isActive: false, revokedAt: new Date(), revokedBy: adminId },
    }).catch(() => {});

    auditLog(adminId, 'UNBAN_USER', { targetType: 'USER', targetId: userId, req });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/users/:id/suspend
export const suspendUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId  = req.user!.userId;
    const userId   = req.params.id as string;
    const { reason, duration } = req.body; // duration in hours

    const expiresAt = duration ? new Date(Date.now() + duration * 60 * 60 * 1000) : undefined;

    await prisma.fraudEnforcementAction.create({
      data: {
        userId,
        actionType: 'SOFT_BAN',
        reason:     reason ?? 'Admin suspension',
        actorId:    adminId,
        isActive:   true,
        expiresAt,
      },
    });

    auditLog(adminId, 'SUSPEND_USER', {
      targetType: 'USER', targetId: userId, metadata: { reason, duration }, req,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/users/:id/enforce
export const enforceUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId  = req.user!.userId;
    const userId   = req.params.id as string;
    const { type, reason, duration } = req.body;

    const validTypes = ['WARN', 'COOLDOWN', 'SHADOW_RESTRICT', 'SOFT_BAN', 'HARD_BAN'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ success: false, message: `type must be one of: ${validTypes.join(', ')}` });
      return;
    }

    const expiresAt = duration ? new Date(Date.now() + duration * 60 * 60 * 1000) : undefined;

    const enforcement = await prisma.fraudEnforcementAction.create({
      data: {
        userId,
        actionType: type,
        reason:     reason ?? 'Admin enforcement',
        actorId:    adminId,
        isActive:   true,
        expiresAt,
      },
    });

    if (type === 'HARD_BAN') {
      await prisma.user.update({ where: { id: userId }, data: { isBanned: true } }).catch(() => {});
      await invalidateBanCache(userId);
    }

    auditLog(adminId, 'ENFORCE', {
      targetType: 'USER', targetId: userId, metadata: { type, reason, duration }, req,
    });

    res.status(200).json({ success: true, data: enforcement });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/users/:id/enforcements/:enforcementId
export const revokeEnforcement = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId       = req.user!.userId;
    const enforcementId = req.params.enforcementId as string;

    const enforcement = await prisma.fraudEnforcementAction.findUnique({
      where: { id: enforcementId },
      select: { id: true, userId: true, actionType: true },
    });
    if (!enforcement) {
      res.status(404).json({ success: false, message: 'Enforcement not found' });
      return;
    }

    await prisma.fraudEnforcementAction.update({
      where: { id: enforcementId },
      data:  { isActive: false, revokedAt: new Date(), revokedBy: adminId },
    });

    auditLog(adminId, 'REVOKE_ENFORCEMENT', {
      targetType: 'USER', targetId: enforcement.userId ?? undefined,
      metadata: { enforcementId, actionType: enforcement.actionType }, req,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/ban/:userId  (legacy)
export const banUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId = req.user!.userId;
    const userId  = req.params.userId as string;
    const { isBanned, reason } = req.body;

    if (typeof isBanned !== 'boolean') {
      res.status(400).json({ success: false, message: 'isBanned (boolean) is required' });
      return;
    }
    if (adminId === userId) {
      res.status(400).json({ success: false, message: 'Cannot ban yourself' });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!target) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    if (target.role === 'admin') {
      res.status(403).json({ success: false, message: 'Cannot ban another admin' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data:  { isBanned: Boolean(isBanned) },
      select: { id: true, isBanned: true },
    });

    await invalidateBanCache(userId);

    auditLog(adminId, isBanned ? 'BAN_USER' : 'UNBAN_USER', {
      targetType: 'USER', targetId: userId, metadata: { reason }, req,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// ── Moderation center ──────────────────────────────────────────────────────────

// GET /api/admin/moderation/reports
export const getModerationReports = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const resolved = qs(req.query.resolved);
    const reason   = qs(req.query.reason);

    const where: any = {};
    if (resolved === 'true')  where.isResolved = true;
    if (resolved === 'false') where.isResolved = false;
    if (reason) where.reason = reason;

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        include: {
          reporter: { select: { id: true, email: true, profile: { select: { username: true } } } },
          reported: { select: { id: true, email: true, isBanned: true, profile: { select: { username: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.report.count({ where }),
    ]);

    res.status(200).json({ success: true, data: pageResponse(reports, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/reports/:id
export const getModerationReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id as string },
      include: {
        reporter: { select: { id: true, email: true, profile: { select: { username: true } } } },
        reported: { select: { id: true, email: true, isBanned: true, profile: { select: { username: true } } } },
      },
    });
    if (!report) {
      res.status(404).json({ success: false, message: 'Report not found' });
      return;
    }
    res.status(200).json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/moderation/reports/:id/resolve
export const resolveModerationReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reportId  = req.params.id as string;
    const { action, reason } = req.body;

    const report = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true } });
    if (!report) {
      res.status(404).json({ success: false, message: 'Report not found' });
      return;
    }

    const updated = await prisma.report.update({
      where: { id: reportId },
      data:  { isResolved: true },
    });

    auditLog(req.user!.userId, 'RESOLVE_REPORT', {
      targetType: 'REPORT', targetId: reportId, metadata: { action, reason }, req,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/moderation/reports/:id/assign
export const assignReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reportId = req.params.id as string;
    const { adminId } = req.body;

    // Report model has no assignedTo — store in audit log as metadata
    const report = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true } });
    if (!report) {
      res.status(404).json({ success: false, message: 'Report not found' });
      return;
    }

    auditLog(req.user!.userId, 'ASSIGN_REPORT', {
      targetType: 'REPORT', targetId: reportId, metadata: { assignedTo: adminId }, req,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/moderation/reports/:id/escalate
export const escalateReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reportId = req.params.id as string;
    const { reason } = req.body;

    const report = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true } });
    if (!report) {
      res.status(404).json({ success: false, message: 'Report not found' });
      return;
    }

    auditLog(req.user!.userId, 'ESCALATE_REPORT', {
      targetType: 'REPORT', targetId: reportId, metadata: { reason }, req,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/reports (legacy)
export const getReports = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const page     = qs(req.query.page)     ?? '1';
    const limit    = qs(req.query.limit)    ?? '20';
    const resolved = qs(req.query.resolved);
    const reason   = qs(req.query.reason);

    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip     = (pageNum - 1) * limitNum;

    const where: any = {};
    if (resolved === 'true')  where.isResolved = true;
    if (resolved === 'false') where.isResolved = false;
    if (reason) where.reason = reason;

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        include: {
          reporter: { select: { id: true, email: true, profile: { select: { username: true } } } },
          reported: { select: { id: true, email: true, isBanned: true, profile: { select: { username: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.report.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: reports,
      meta: { page: pageNum, limit: limitNum, total },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/reports/:reportId/resolve (legacy)
export const resolveReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reportId = req.params.reportId as string;
    const { notes } = req.body;

    const report = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true } });
    if (!report) {
      res.status(404).json({ success: false, message: 'Report not found' });
      return;
    }

    const updated = await prisma.report.update({
      where: { id: reportId },
      data:  { isResolved: true },
    });

    auditLog(req.user!.userId, 'RESOLVE_REPORT', {
      targetType: 'REPORT', targetId: reportId, metadata: { notes }, req,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/stats
export const getModerationStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [pendingReports, pendingAiFlags, pendingAppeals, pendingMedia] = await Promise.all([
      prisma.report.count({ where: { isResolved: false } }),
      prisma.fraudCase.count({ where: { status: 'PENDING' } }),
      prisma.moderationAppeal.count({ where: { status: 'PENDING' } }),
      prisma.mediaAsset.count({ where: { moderationState: 'PENDING' } }),
    ]);

    // Legacy fields
    const resolvedToday = await prisma.report.count({
      where: {
        isResolved: true,
        createdAt:  { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }).catch(() => 0);

    res.status(200).json({
      success: true,
      data: {
        pendingReports,
        pendingAiFlags,
        pendingAppeals,
        pendingMedia,
        // legacy
        openReports:     pendingReports,
        resolvedToday,
        quarantinedMedia: await prisma.mediaAsset.count({ where: { status: 'QUARANTINED' } }).catch(() => 0),
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/ai-flags
export const getAiFlags = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);

    // Use FraudCase as the AI flag source — cases represent automated detections
    const where: any = { status: 'PENDING' };

    const [cases, total] = await Promise.all([
      prisma.fraudCase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.fraudCase.count({ where }),
    ]);

    // Enrich with user emails
    const userIds   = [...new Set(cases.map((c) => c.userId))];
    const users     = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, profile: { select: { username: true } } },
    }).catch(() => [] as any[]);
    const userMap   = Object.fromEntries(users.map((u: any) => [u.id, u]));

    const flags = cases.map((c) => ({
      id:          c.id,
      userId:      c.userId,
      user:        userMap[c.userId] ? { name: userMap[c.userId].profile?.username ?? c.userId, email: userMap[c.userId].email } : null,
      riskScore:   c.riskScore,
      signals:     c.signals,
      status:      c.status,
      priority:    c.priority,
      reviewNotes: c.reviewNotes,
      createdAt:   c.createdAt,
    }));

    res.status(200).json({ success: true, data: pageResponse(flags, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/moderation/ai-flags/:id/review
export const reviewAiFlag = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const caseId        = req.params.id as string;
    const { action, note } = req.body; // action: RESOLVE | DISMISS | ESCALATE

    const fraudCase = await prisma.fraudCase.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!fraudCase) {
      res.status(404).json({ success: false, message: 'AI flag not found' });
      return;
    }

    const statusMap: Record<string, string> = {
      RESOLVE:  'RESOLVED',
      DISMISS:  'DISMISSED',
      ESCALATE: 'IN_REVIEW',
    };

    const updated = await prisma.fraudCase.update({
      where: { id: caseId },
      data:  {
        status:      statusMap[action] ?? 'RESOLVED',
        reviewerId:  req.user!.userId,
        reviewNotes: note,
        resolvedAt:  ['RESOLVED', 'DISMISSED'].includes(statusMap[action] ?? '') ? new Date() : undefined,
        actionTaken: action,
      },
    });

    auditLog(req.user!.userId, 'REVIEW_AI_FLAG', {
      targetType: 'FRAUD_CASE', targetId: caseId, metadata: { action, note }, req,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/moderation/appeals
export const getAppeals = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const status = qs(req.query.status);

    const where: any = {};
    if (status) where.status = status;
    else where.status = 'PENDING';

    const [appeals, total] = await Promise.all([
      prisma.moderationAppeal.findMany({
        where,
        include: {
          event: { select: { id: true, triggerReason: true, decision: true, sourceType: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.moderationAppeal.count({ where }),
    ]);

    // Enrich with user info
    const userIds = [...new Set(appeals.map((a) => a.userId))];
    const users   = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, profile: { select: { username: true } } },
    }).catch(() => [] as any[]);
    const userMap = Object.fromEntries(users.map((u: any) => [u.id, u]));

    const enriched = appeals.map((a) => ({
      ...a,
      user: userMap[a.userId] ?? null,
    }));

    res.status(200).json({ success: true, data: pageResponse(enriched, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/moderation/appeals/:id/review
export const reviewAppeal = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const appealId       = req.params.id as string;
    const { decision, note } = req.body; // decision: APPROVED | DENIED

    const appeal = await prisma.moderationAppeal.findUnique({ where: { id: appealId }, select: { id: true } });
    if (!appeal) {
      res.status(404).json({ success: false, message: 'Appeal not found' });
      return;
    }

    const updated = await prisma.moderationAppeal.update({
      where: { id: appealId },
      data:  {
        status:      decision === 'APPROVED' ? 'APPROVED' : 'DENIED',
        reviewerId:  req.user!.userId,
        reviewNotes: note,
        reviewedAt:  new Date(),
      },
    });

    auditLog(req.user!.userId, 'REVIEW_APPEAL', {
      targetType: 'APPEAL', targetId: appealId, metadata: { decision, note }, req,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// ── Media moderation ───────────────────────────────────────────────────────────

// GET /api/admin/moderation/media
export const getModerationMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const state  = qs(req.query.state) ?? 'PENDING';

    const where: any = { moderationState: state };

    const [assets, total] = await Promise.all([
      prisma.mediaAsset.findMany({
        where,
        include: {
          user:        { select: { id: true, email: true, profile: { select: { username: true } } } },
          moderations: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: pageSize,
      }),
      prisma.mediaAsset.count({ where }),
    ]);

    res.status(200).json({ success: true, data: pageResponse(assets, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/moderation/media/:id
export const reviewModerationMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const assetId      = req.params.id as string;
    const { action }   = req.body; // APPROVE | QUARANTINE | DELETE

    if (!['APPROVE', 'QUARANTINE', 'DELETE'].includes(action)) {
      res.status(400).json({ success: false, message: 'action must be APPROVE | QUARANTINE | DELETE' });
      return;
    }

    const decisionMap: Record<string, string> = {
      APPROVE:    'APPROVED',
      QUARANTINE: 'QUARANTINED',
      DELETE:     'QUARANTINED',
    };
    const statusMap: Record<string, string> = {
      APPROVE:    'READY',
      QUARANTINE: 'QUARANTINED',
      DELETE:     'DELETED',
    };

    await prisma.$transaction([
      prisma.mediaAsset.update({
        where: { id: assetId },
        data:  {
          moderationState: decisionMap[action],
          status:          statusMap[action],
          ...(action === 'DELETE' ? { deletedAt: new Date() } : {}),
        },
      }),
      prisma.mediaModeration.create({
        data: {
          assetId,
          provider:    'manual',
          result:      {} as object,
          isNsfw:      action !== 'APPROVE',
          reviewerId:  req.user!.userId,
          reviewNotes: action,
          reviewedAt:  new Date(),
          labels:      [],
        },
      }),
    ]);

    auditLog(req.user!.userId, 'MEDIA_REVIEW', {
      targetType: 'MEDIA', targetId: assetId, metadata: { action }, req,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/media (legacy)
export const getPendingMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const state  = qs(req.query.state)  ?? 'PENDING';
    const limit  = Math.min(50, parseInt(qs(req.query.limit) ?? '20', 10));
    const cursor = qs(req.query.cursor);

    const assets = await prisma.mediaAsset.findMany({
      where: {
        moderationState: state,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      include: {
        user:        { select: { id: true, email: true, profile: { select: { username: true } } } },
        moderations: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    res.status(200).json({
      success: true,
      data: assets,
      meta: { count: assets.length, nextCursor: assets.length === limit ? assets[limit - 1]?.id : null },
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/media/:assetId/review (legacy)
export const reviewMedia = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const assetId             = req.params.assetId as string;
    const { decision, notes } = req.body;

    if (!['APPROVED', 'REJECTED', 'QUARANTINED'].includes(decision)) {
      res.status(400).json({ success: false, message: 'decision must be APPROVED | REJECTED | QUARANTINED' });
      return;
    }

    const statusMap: Record<string, string> = {
      APPROVED:    'READY',
      REJECTED:    'QUARANTINED',
      QUARANTINED: 'QUARANTINED',
    };

    await prisma.$transaction([
      prisma.mediaAsset.update({
        where: { id: assetId },
        data:  { moderationState: decision, status: statusMap[decision] },
      }),
      prisma.mediaModeration.create({
        data: {
          assetId,
          provider:    'manual',
          result:      {} as object,
          isNsfw:      decision !== 'APPROVED',
          reviewerId:  req.user!.userId,
          reviewNotes: notes,
          reviewedAt:  new Date(),
          labels:      [],
        },
      }),
    ]);

    auditLog(req.user!.userId, 'MEDIA_REVIEW', {
      targetType: 'MEDIA', targetId: assetId, metadata: { decision, notes }, req,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── Fraud ──────────────────────────────────────────────────────────────────────

// GET /api/admin/fraud/stats
export const getFraudStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [activeAlerts, blockedIps, bannedLastWeek, openSignals, activeClusters, resolvedCases, totalCases] =
      await Promise.all([
        prisma.fraudCase.count({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } } }),
        prisma.fraudEnforcementAction.count({ where: { actionType: 'IP_BLOCK', isActive: true } }).catch(() => 0),
        prisma.user.count({ where: { isBanned: true, createdAt: { gte: weekAgo } } }),
        prisma.fraudSignal.count({ where: { resolvedAt: null } }),
        prisma.deviceFingerprint.count({ where: { riskLevel: { in: ['HIGH', 'CRITICAL', 'EXTREME'] } } }),
        prisma.fraudCase.count({ where: { status: 'RESOLVED', createdAt: { gte: weekAgo } } }),
        prisma.fraudCase.count({ where: { createdAt: { gte: weekAgo } } }),
      ]);

    const detectionRate = totalCases > 0
      ? Math.round((resolvedCases / totalCases) * 10000) / 100
      : 0;

    res.status(200).json({
      success: true,
      data: {
        activeAlerts,
        blockedIps,
        bannedLastWeek,
        detectionRate,
        openSignals,
        activeClusters,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/fraud/alerts
export const getFraudAlerts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);

    const where: any = { status: { in: ['PENDING', 'IN_REVIEW'] } };

    const [cases, total] = await Promise.all([
      prisma.fraudCase.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      prisma.fraudCase.count({ where }),
    ]);

    // Enrich with user info
    const userIds = [...new Set(cases.map((c) => c.userId))];
    const users   = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, profile: { select: { username: true } } },
    }).catch(() => [] as any[]);
    const userMap = Object.fromEntries(users.map((u: any) => [u.id, u]));

    const alerts = cases.map((c) => ({
      id:        c.id,
      userId:    c.userId,
      user:      userMap[c.userId]
        ? { name: userMap[c.userId].profile?.username ?? c.userId, email: userMap[c.userId].email }
        : null,
      riskScore: c.riskScore,
      signals:   c.signals,
      status:    c.status,
      priority:  c.priority,
      createdAt: c.createdAt,
    }));

    res.status(200).json({ success: true, data: pageResponse(alerts, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/fraud/patterns
export const getFraudPatterns = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days  = Math.min(90, parseInt(qs(req.query.days) ?? '30', 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Aggregate fraud signals by day and type
    const signals = await prisma.fraudSignal.findMany({
      where: { createdAt: { gte: since } },
      select: { signalType: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }).catch(() => [] as any[]);

    // Build daily signal counts
    const dailyMap: Record<string, { deviceFingerprint: number; ipCluster: number; behaviorAnomaly: number }> = {};
    for (const s of signals) {
      const date = new Date(s.createdAt).toISOString().slice(0, 10);
      if (!dailyMap[date]) dailyMap[date] = { deviceFingerprint: 0, ipCluster: 0, behaviorAnomaly: 0 };
      const type = s.signalType as string;
      if (type.includes('DEVICE') || type.includes('FINGERPRINT')) dailyMap[date].deviceFingerprint++;
      else if (type.includes('IP') || type.includes('CLUSTER'))    dailyMap[date].ipCluster++;
      else                                                          dailyMap[date].behaviorAnomaly++;
    }

    const dailySignals = Object.entries(dailyMap).map(([date, v]) => ({ date, ...v }));

    // Top signal types
    const typeMap: Record<string, number> = {};
    for (const s of signals) {
      typeMap[s.signalType] = (typeMap[s.signalType] ?? 0) + 1;
    }
    const total     = signals.length;
    const topTypes  = Object.entries(typeMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([type, count]) => ({
        type,
        count,
        pct: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
      }));

    res.status(200).json({ success: true, data: { dailySignals, topTypes } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/fraud/ip-blocks
export const getIpBlocks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);

    // IP blocks are stored as FraudEnforcementAction with actionType = 'IP_BLOCK'
    const where: any = { actionType: 'IP_BLOCK', isActive: true };

    const [blocks, total] = await Promise.all([
      prisma.fraudEnforcementAction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.fraudEnforcementAction.count({ where }),
    ]);

    const data = blocks.map((b) => ({
      id:        b.id,
      ip:        (b.metadata as any)?.ip ?? 'unknown',
      reason:    b.reason,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
    }));

    res.status(200).json({ success: true, data: pageResponse(data, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/fraud/ip-blocks
export const addIpBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId = req.user!.userId;
    const { ip, reason, ttlHours } = req.body;

    if (!ip || !reason) {
      res.status(400).json({ success: false, message: 'ip and reason are required' });
      return;
    }

    const expiresAt = ttlHours ? new Date(Date.now() + ttlHours * 60 * 60 * 1000) : undefined;

    const block = await prisma.fraudEnforcementAction.create({
      data: {
        actionType: 'IP_BLOCK',
        reason,
        actorId:    adminId,
        isActive:   true,
        expiresAt,
        metadata:   { ip } as object,
      },
    });

    auditLog(adminId, 'IP_BLOCK_ADD', {
      metadata: { ip, reason, ttlHours }, req,
    });

    res.status(200).json({ success: true, data: { id: block.id, ip, reason, createdAt: block.createdAt, expiresAt: block.expiresAt } });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/fraud/ip-blocks/:ip
export const removeIpBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId = req.user!.userId;
    const ip      = req.params.ip as string;

    // Find and deactivate matching IP block
    await prisma.fraudEnforcementAction.updateMany({
      where: {
        actionType: 'IP_BLOCK',
        isActive:   true,
        metadata:   { path: ['ip'], equals: ip },
      },
      data: { isActive: false, revokedAt: new Date(), revokedBy: adminId },
    });

    auditLog(adminId, 'IP_BLOCK_REMOVE', { metadata: { ip }, req });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/fraud/bulk-action
export const fraudBulkAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const adminId = req.user!.userId;
    const { userIds, action, reason } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ success: false, message: 'userIds array is required' });
      return;
    }

    const validActions = ['BAN', 'UNBAN', 'WARN', 'SUSPEND'];
    if (!validActions.includes(action)) {
      res.status(400).json({ success: false, message: `action must be one of: ${validActions.join(', ')}` });
      return;
    }

    if (action === 'BAN') {
      await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { isBanned: true } });
      await prisma.fraudEnforcementAction.createMany({
        data: userIds.map((uid: string) => ({
          userId:     uid,
          actionType: 'HARD_BAN',
          reason:     reason ?? 'Bulk ban',
          actorId:    adminId,
          isActive:   true,
        })),
      }).catch(() => {});
      for (const uid of userIds) {
        await invalidateBanCache(uid).catch(() => {});
      }
    } else if (action === 'UNBAN') {
      await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { isBanned: false } });
      await prisma.fraudEnforcementAction.updateMany({
        where: { userId: { in: userIds }, actionType: 'HARD_BAN', isActive: true },
        data:  { isActive: false, revokedAt: new Date(), revokedBy: adminId },
      }).catch(() => {});
      for (const uid of userIds) {
        await invalidateBanCache(uid).catch(() => {});
      }
    } else if (action === 'WARN') {
      await prisma.fraudEnforcementAction.createMany({
        data: userIds.map((uid: string) => ({
          userId:     uid,
          actionType: 'WARN',
          reason:     reason ?? 'Bulk warn',
          actorId:    adminId,
          isActive:   true,
        })),
      }).catch(() => {});
    } else if (action === 'SUSPEND') {
      await prisma.fraudEnforcementAction.createMany({
        data: userIds.map((uid: string) => ({
          userId:     uid,
          actionType: 'SOFT_BAN',
          reason:     reason ?? 'Bulk suspend',
          actorId:    adminId,
          isActive:   true,
        })),
      }).catch(() => {});
    }

    auditLog(adminId, 'BULK_ACTION', {
      metadata: { action, userCount: userIds.length, reason }, req,
    });

    res.status(200).json({ success: true, data: { affected: userIds.length } });
  } catch (error) {
    next(error);
  }
};

// ── Revenue ────────────────────────────────────────────────────────────────────

// GET /api/admin/revenue/overview
export const getRevenueOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days    = Math.min(365, parseInt(qs(req.query.days) ?? '30', 10));
    const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const prevStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000);

    const [
      revNow,
      revPrev,
      activeSubsNow,
      activeSubsPrev,
      ltvRows,
      totalUsers,
      churned,
      boostRevRows,
    ] = await Promise.all([
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: since } }, _sum: { amountUsd: true } }),
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: prevStart, lt: since } }, _sum: { amountUsd: true } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', createdAt: { lt: since } } }),
      prisma.spenderSegment.aggregate({ _avg: { ltv: true }, _sum: { ltv: true } }),
      prisma.user.count(),
      prisma.subscription.count({ where: { status: { in: ['CANCELLED', 'EXPIRED'] }, updatedAt: { gte: since } } }),
      prisma.paymentSession.aggregate({
        where: { status: 'SUCCESS', productType: 'BOOST', createdAt: { gte: since } },
        _sum: { amountUsd: true },
      }),
    ]);

    const mrr        = Number(revNow._sum.amountUsd ?? 0);
    const prevMrr    = Number(revPrev._sum.amountUsd ?? 0);
    const avgLtv     = Number(ltvRows._avg?.ltv ?? 0);
    const arpu       = totalUsers > 0 ? mrr / totalUsers : 0;
    const churnRate  = activeSubsNow > 0 ? Math.round((churned / activeSubsNow) * 10000) / 100 : 0;
    const pctChange  = (a: number, b: number) => b === 0 ? 0 : Math.round(((a - b) / b) * 1000) / 10;

    res.status(200).json({
      success: true,
      data: {
        mrr,
        arr:                mrr * 12,
        activeSubscriptions: activeSubsNow,
        avgLtv,
        arpu:               Math.round(arpu * 100) / 100,
        churnRate,
        conversionRate:     0,
        boostRevenue:       Number(boostRevRows._sum.amountUsd ?? 0),
        mrrChange:          pctChange(mrr, prevMrr),
        subGrowth:          activeSubsNow - activeSubsPrev,
        ltvChange:          0,
        churnChange:        0,
        conversionChange:   0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/revenue/charts
export const getRevenueCharts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days  = Math.min(365, parseInt(qs(req.query.days) ?? '30', 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const snapshots = await prisma.revenueSnapshot.findMany({
      where: { granularity: 'DAY', periodStart: { gte: since } },
      orderBy: { periodStart: 'asc' },
    }).catch(() => [] as any[]);

    const daily = snapshots.map((s: any) => ({
      date:          s.periodStart.toISOString().slice(0, 10),
      subscriptions: Number(s.subscriptionRev),
      boosts:        Number(s.boostRev),
      gifts:         Number(s.creditPackRev),
    }));

    const subscriptions = snapshots.map((s: any) => ({
      date:    s.periodStart.toISOString().slice(0, 10),
      new:     s.newSubscribers,
      churned: s.churned,
    }));

    res.status(200).json({ success: true, data: { daily, subscriptions } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/revenue/plans
export const getRevenuePlans = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const planCounts = await prisma.subscription.groupBy({
      by: ['tier'],
      where: { status: 'ACTIVE' },
      _count: { id: true },
    }).catch(() => [] as any[]);

    // Revenue per plan from PaymentSession
    const planRevenue = await prisma.paymentSession.groupBy({
      by: ['productId'],
      where: { status: 'SUCCESS' },
      _sum: { amountUsd: true },
    }).catch(() => [] as any[]);

    const totalSubs    = planCounts.reduce((a: number, b: any) => a + b._count.id, 0);
    const totalRevenue = planRevenue.reduce((a: number, b: any) => a + Number(b._sum.amountUsd ?? 0), 0);

    const plans = planCounts.map((p: any) => ({
      id:          p.tier,
      name:        p.tier,
      subscribers: p._count.id,
      revenue:     totalRevenue * (p._count.id / Math.max(totalSubs, 1)),
      pct:         totalSubs > 0 ? Math.round((p._count.id / totalSubs) * 10000) / 100 : 0,
    }));

    res.status(200).json({ success: true, data: { plans } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/revenue/cohorts
export const getRevenueCohorts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const months = Math.min(24, parseInt(qs(req.query.months) ?? '6', 10));

    const rows = await prisma.analyticsAggregation.findMany({
      where: {
        aggType:    { in: ['RETENTION_D1', 'RETENTION_D7', 'RETENTION_D30'] },
        periodDate: { gte: new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { periodDate: 'asc' },
    }).catch(() => [] as any[]);

    // Build a simplified cohort structure
    const monthLabels: string[] = [];
    const cohortMap: Record<string, number[]> = {};

    for (const row of rows) {
      const label = new Date(row.periodDate).toISOString().slice(0, 7); // YYYY-MM
      if (!monthLabels.includes(label)) monthLabels.push(label);
      if (!cohortMap[label]) cohortMap[label] = [0, 0, 0];

      if (row.aggType === 'RETENTION_D1')  cohortMap[label][0] = row.value;
      if (row.aggType === 'RETENTION_D7')  cohortMap[label][1] = row.value;
      if (row.aggType === 'RETENTION_D30') cohortMap[label][2] = row.value;
    }

    const cohorts = monthLabels.map((month) => ({
      month,
      retention: cohortMap[month] ?? [0, 0, 0],
    }));

    res.status(200).json({ success: true, data: { months: monthLabels, cohorts } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/analytics/retention
export const getRetention = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(90, parseInt(qs(req.query.days) ?? '30', 10));
    const data = await getRetentionData(days);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/analytics/revenue
export const getRevenue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = Math.min(90, parseInt(qs(req.query.days) ?? '30', 10));
    const [timeSeries, topSpenders] = await Promise.all([
      getRevenueTimeSeries(days),
      getTopSpenders(20),
    ]);
    res.status(200).json({ success: true, data: { timeSeries, topSpenders } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/analytics/funnel
export const getFunnelData = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days  = Math.min(90, parseInt(qs(req.query.days) ?? '30', 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.analyticsAggregation.findMany({
      where: {
        aggType:    { in: ['FUNNEL_PROFILE_COMPLETE', 'FUNNEL_FIRST_LIKE', 'FUNNEL_FIRST_MESSAGE'] },
        periodDate: { gte: since },
      },
      orderBy: { periodDate: 'asc' },
    });

    const byType: Record<string, Array<{ date: string; rate: number; n: number }>> = {};
    for (const r of rows) {
      if (!byType[r.aggType]) byType[r.aggType] = [];
      byType[r.aggType].push({
        date: r.periodDate.toISOString().slice(0, 10),
        rate: r.value,
        n:    r.sampleSize,
      });
    }

    res.status(200).json({ success: true, data: byType });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/analytics/backfill
export const triggerBackfill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { date } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) is required' });
      return;
    }

    await triggerAggregationForDate(date);
    auditLog(req.user!.userId, 'ANALYTICS_BACKFILL', { metadata: { date }, req });
    res.status(200).json({ success: true, message: `Backfill job queued for ${date}` });
  } catch (error) {
    next(error);
  }
};

// ── Payments ───────────────────────────────────────────────────────────────────

// GET /api/admin/payments/stats
export const getPaymentStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [vol24h, success24h, total24h, disputed, refunded, total30d] = await Promise.all([
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: since24h } }, _sum: { amountUsd: true } }),
      prisma.paymentSession.count({ where: { status: 'SUCCESS', createdAt: { gte: since24h } } }),
      prisma.paymentSession.count({ where: { createdAt: { gte: since24h } } }),
      prisma.paymentSession.count({ where: { status: 'DISPUTED' } }),
      prisma.paymentSession.count({ where: { status: 'REFUNDED', createdAt: { gte: since30d } } }),
      prisma.paymentSession.count({ where: { createdAt: { gte: since30d } } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        volume24h:    Number(vol24h._sum.amountUsd ?? 0),
        successRate:  total24h > 0 ? Math.round((success24h / total24h) * 10000) / 100 : 0,
        openDisputes: disputed,
        refundRate:   total30d  > 0 ? Math.round((refunded / total30d) * 10000) / 100 : 0,
        volumeChange: 0,
        successChange: 0,
        refundChange: 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/payments
export const getPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const status   = qs(req.query.status);
    const userId   = qs(req.query.userId);
    const provider = qs(req.query.provider);

    const where: any = {};
    if (status)   where.status   = status;
    if (userId)   where.userId   = userId;
    if (provider) where.provider = provider;

    const [sessions, total] = await Promise.all([
      prisma.paymentSession.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, profile: { select: { username: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.paymentSession.count({ where }),
    ]);

    res.status(200).json({ success: true, data: pageResponse(sessions, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/payments/:id
export const getPaymentDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await prisma.paymentSession.findUnique({
      where: { id: req.params.id as string },
      include: {
        user:           { select: { id: true, email: true, profile: { select: { username: true } } } },
        subscription:   true,
        providerEvents: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!session) {
      res.status(404).json({ success: false, message: 'Payment session not found' });
      return;
    }
    res.status(200).json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/payments/:id/refund
export const refundPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId     = req.params.id as string;
    const { amount, reason } = req.body;

    const session = await prisma.paymentSession.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, amountUsd: true },
    });
    if (!session) {
      res.status(404).json({ success: false, message: 'Payment session not found' });
      return;
    }
    if (session.status === 'REFUNDED') {
      res.status(400).json({ success: false, message: 'Already refunded' });
      return;
    }

    const updated = await prisma.paymentSession.update({
      where: { id: sessionId },
      data:  {
        status:         'REFUNDED',
        refundedAt:     new Date(),
        refundAmountUsd: amount ?? session.amountUsd,
      },
    });

    auditLog(req.user!.userId, 'PAYMENT_REFUND', {
      targetType: 'PAYMENT', targetId: sessionId,
      metadata: { amount, reason }, req,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/payments/disputes
export const getPaymentDisputes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);

    const [sessions, total] = await Promise.all([
      prisma.paymentSession.findMany({
        where: { status: 'DISPUTED' },
        include: {
          user: { select: { id: true, email: true, profile: { select: { username: true } } } },
        },
        orderBy: { disputedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.paymentSession.count({ where: { status: 'DISPUTED' } }),
    ]);

    res.status(200).json({ success: true, data: pageResponse(sessions, total, page, pageSize) });
  } catch (error) {
    next(error);
  }
};

// ── Feature flags ──────────────────────────────────────────────────────────────

// GET /api/admin/flags
export const getFeatureFlags = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const flags = await prisma.featureFlag.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    res.status(200).json({
      success: true,
      data: {
        flags: flags.map((f) => ({
          id:          f.id,
          key:         f.key,
          name:        f.key,
          description: f.description,
          enabled:     f.enabled,
          rolloutPct:  f.rolloutPercentage,
          platform:    f.platforms.length > 0 ? f.platforms.join(',') : null,
          tags:        f.regions,
          createdAt:   f.createdAt,
          updatedAt:   f.updatedAt,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/flags
export const createFeatureFlag = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      key, description, enabled, rolloutPct,
      platform, tags, targetUserIds, blockedUserIds, expiresAt,
    } = req.body;

    if (!key) {
      res.status(400).json({ success: false, message: 'key is required' });
      return;
    }

    const flag = await prisma.featureFlag.create({
      data: {
        key,
        description:        description ?? '',
        enabled:            enabled      ?? false,
        rolloutPercentage:  rolloutPct   ?? 0,
        platforms:          platform ? [platform] : [],
        regions:            tags ?? [],
        targetUserIds:      targetUserIds  ?? [],
        blockedUserIds:     blockedUserIds ?? [],
        expiresAt:          expiresAt ? new Date(expiresAt) : undefined,
      },
    });

    // Audit
    await prisma.featureFlagAuditLog.create({
      data: { flagId: flag.id, actorId: req.user!.userId, action: 'CREATED', after: flag as object },
    }).catch(() => {});

    auditLog(req.user!.userId, 'FLAG_CREATE', { targetType: 'FLAG', targetId: flag.id, metadata: { key }, req });

    res.status(201).json({
      success: true,
      data: {
        id:          flag.id,
        key:         flag.key,
        name:        flag.key,
        description: flag.description,
        enabled:     flag.enabled,
        rolloutPct:  flag.rolloutPercentage,
        platform:    flag.platforms.join(',') || null,
        tags:        flag.regions,
        createdAt:   flag.createdAt,
        updatedAt:   flag.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/flags/:key
export const updateFeatureFlag = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const flagKey = req.params.key as string;
    const {
      description, enabled, rolloutPct, platform, tags,
      targetUserIds, blockedUserIds, expiresAt,
    } = req.body;

    const existing = await prisma.featureFlag.findUnique({ where: { key: flagKey } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Flag not found' });
      return;
    }

    const flag = await prisma.featureFlag.update({
      where: { key: flagKey },
      data: {
        ...(description    !== undefined ? { description }                        : {}),
        ...(enabled        !== undefined ? { enabled }                            : {}),
        ...(rolloutPct     !== undefined ? { rolloutPercentage: rolloutPct }      : {}),
        ...(platform       !== undefined ? { platforms: platform ? [platform] : [] } : {}),
        ...(tags           !== undefined ? { regions: tags }                      : {}),
        ...(targetUserIds  !== undefined ? { targetUserIds }                      : {}),
        ...(blockedUserIds !== undefined ? { blockedUserIds }                     : {}),
        ...(expiresAt      !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
      },
    });

    await prisma.featureFlagAuditLog.create({
      data: { flagId: flag.id, actorId: req.user!.userId, action: 'UPDATED', before: existing as object, after: flag as object },
    }).catch(() => {});

    auditLog(req.user!.userId, 'FLAG_UPDATE', { targetType: 'FLAG', targetId: flag.id, metadata: { key: flagKey }, req });

    res.status(200).json({
      success: true,
      data: {
        id:          flag.id,
        key:         flag.key,
        name:        flag.key,
        description: flag.description,
        enabled:     flag.enabled,
        rolloutPct:  flag.rolloutPercentage,
        platform:    flag.platforms.join(',') || null,
        tags:        flag.regions,
        createdAt:   flag.createdAt,
        updatedAt:   flag.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/flags/:key
export const deleteFeatureFlag = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const flagKey = req.params.key as string;

    const existing = await prisma.featureFlag.findUnique({ where: { key: flagKey }, select: { id: true } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Flag not found' });
      return;
    }

    await prisma.featureFlagAuditLog.create({
      data: { flagId: existing.id, actorId: req.user!.userId, action: 'DELETED' },
    }).catch(() => {});

    await prisma.featureFlag.delete({ where: { key: flagKey } });

    auditLog(req.user!.userId, 'FLAG_DELETE', { targetType: 'FLAG', targetId: existing.id, metadata: { key: flagKey }, req });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── Queue monitoring ───────────────────────────────────────────────────────────

// GET /api/admin/queues
export const getQueues = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stats  = await getQueueStats();
    const queues = stats.map((s) => ({
      name:         s.name,
      waiting:      s.waiting,
      active:       s.active,
      failed:       s.failed,
      completed:    s.completed,
      paused:       s.paused,
      workersCount: s.active,  // BullMQ active = workers executing
    }));
    res.status(200).json({ success: true, data: { queues } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/queues/:name/jobs
export const getQueueJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const queueName = req.params.name as string;
    const status    = qs(req.query.status) ?? 'failed';
    const limit     = Math.min(100, parseInt(qs(req.query.limit) ?? '50', 10));

    // Currently only failed jobs are fully supported via queue.monitor
    const jobs = status === 'failed'
      ? await getFailedJobs(queueName, limit)
      : await getFailedJobs(queueName, limit); // fallback to failed for other statuses

    const normalized = jobs.map((j) => ({
      id:          j.id,
      name:        j.name,
      data:        j.data,
      failedReason: j.failedReason,
      processedOn: null,
      finishedOn:  null,
      attempts:    j.attemptsMade,
      timestamp:   j.timestamp,
    }));

    res.status(200).json({ success: true, data: { jobs: normalized } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/queues/:name/failed (legacy)
export const getQueueFailedJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(50, parseInt(qs(req.query.limit) ?? '20', 10));
    const jobs  = await getFailedJobs((req.params.name as string), limit);
    res.status(200).json({ success: true, data: jobs });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/queues/:name/jobs/:jobId/retry
export const retryJobNew = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await retryFailedJob((req.params.name as string), (req.params.jobId as string));
    auditLog(req.user!.userId, 'QUEUE_RETRY_JOB', {
      targetType: 'JOB', targetId: (req.params.jobId as string),
      metadata: { queue: (req.params.name as string) }, req,
    });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/queues/:name/retry/:jobId (legacy)
export const retryJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await retryFailedJob((req.params.name as string), (req.params.jobId as string));
    auditLog(req.user!.userId, 'QUEUE_RETRY_JOB', {
      targetType: 'JOB', targetId: (req.params.jobId as string),
      metadata: { queue: (req.params.name as string) }, req,
    });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/queues/:name/retry-all (legacy)
export const retryAllJobsInQueue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const count = await retryAllFailed((req.params.name as string));
    auditLog(req.user!.userId, 'QUEUE_RETRY_ALL', {
      targetType: 'JOB', metadata: { queue: (req.params.name as string), count }, req,
    });
    res.status(200).json({ success: true, data: { retriedCount: count } });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/queues/:name/failed
export const clearFailedJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const count = await retryAllFailed((req.params.name as string));
    auditLog(req.user!.userId, 'QUEUE_CLEAR_FAILED', {
      metadata: { queue: (req.params.name as string), count }, req,
    });
    res.status(200).json({ success: true, data: { cleared: count } });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/queues/:name/pause
export const pauseQueueHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await pauseQueue((req.params.name as string));
    auditLog(req.user!.userId, 'QUEUE_PAUSE', {
      targetType: 'JOB', metadata: { queue: (req.params.name as string) }, req,
    });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/queues/:name/resume
export const resumeQueueHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await resumeQueue((req.params.name as string));
    auditLog(req.user!.userId, 'QUEUE_RESUME', {
      targetType: 'JOB', metadata: { queue: (req.params.name as string) }, req,
    });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/queues/:name/drain
export const drainQueueHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await drainQueue((req.params.name as string));
    auditLog(req.user!.userId, 'QUEUE_DRAIN', {
      targetType: 'JOB', metadata: { queue: (req.params.name as string) }, req,
    });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── Whale intelligence ─────────────────────────────────────────────────────────

// GET /api/admin/whale/overview
export const getWhaleOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days    = Math.min(365, parseInt(qs(req.query.days) ?? '30', 10));
    const since   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const prevStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000);

    const [whaleSegments, atRisk, ltvNow, ltvPrev, revNow, revPrev] = await Promise.all([
      prisma.spenderSegment.findMany({
        where: { segment: { in: ['WHALE', 'VIP'] } },
        select: { userId: true, totalSpend: true, ltv: true, fatigueScore: true, lastPurchaseAt: true },
      }).catch(() => [] as any[]),
      prisma.spenderSegment.count({ where: { segment: { in: ['WHALE', 'VIP'] }, fatigueScore: { gt: 0.7 } } }).catch(() => 0),
      prisma.spenderSegment.aggregate({ where: { segment: { in: ['WHALE', 'VIP'] } }, _avg: { ltv: true } }).catch(() => ({ _avg: { ltv: 0 } } as any)),
      prisma.spenderSegment.aggregate({ where: { segment: { in: ['WHALE', 'VIP'] } }, _avg: { ltv: true } }).catch(() => ({ _avg: { ltv: 0 } } as any)),
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: since } }, _sum: { amountUsd: true } }).catch(() => ({ _sum: { amountUsd: 0 } } as any)),
      prisma.paymentSession.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: prevStart, lt: since } }, _sum: { amountUsd: true } }).catch(() => ({ _sum: { amountUsd: 0 } } as any)),
    ]);

    const whaleRev = whaleSegments.reduce((a: number, s: any) => a + Number(s.totalSpend), 0);
    const revN     = Number(revNow._sum.amountUsd  ?? 0);
    const revP     = Number(revPrev._sum.amountUsd ?? 0);

    res.status(200).json({
      success: true,
      data: {
        whaleCount:    whaleSegments.length,
        whaleRevenue:  whaleRev,
        avgLtv:        Number(ltvNow._avg?.ltv ?? 0),
        atRiskCount:   atRisk,
        revenueChange: revP > 0 ? Math.round(((revN - revP) / revP) * 1000) / 10 : 0,
        ltvChange:     0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/whale/top-spenders
export const getWhaleTopSpenders = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(100, parseInt(qs(req.query.limit) ?? '10', 10));

    const segments = await prisma.spenderSegment.findMany({
      where: { totalSpend: { gt: 0 } },
      orderBy: { totalSpend: 'desc' },
      take: limit,
    }).catch(() => [] as any[]);

    const userIds = segments.map((s: any) => s.userId);
    const [users, activeSubs] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, lastSeen: true, profile: { select: { username: true } } },
      }).catch(() => [] as any[]),
      prisma.subscription.findMany({
        where: { userId: { in: userIds }, status: 'ACTIVE' },
        select: { userId: true, tier: true },
      }).catch(() => [] as any[]),
    ]);

    const userMap = Object.fromEntries(users.map((u: any) => [u.id, u]));
    const subMap  = Object.fromEntries(activeSubs.map((s: any) => [s.userId, s.tier]));

    const result = segments.map((s: any, i: number) => ({
      id:            s.userId,
      rank:          i + 1,
      name:          userMap[s.userId]?.profile?.username ?? s.userId,
      email:         userMap[s.userId]?.email ?? '',
      totalSpent:    Number(s.totalSpend),
      plan:          subMap[s.userId] ?? 'FREE',
      lastActiveAt:  userMap[s.userId]?.lastSeen ?? null,
      churnRisk:     s.fatigueScore > 0.7 ? 'HIGH' : s.fatigueScore > 0.4 ? 'MEDIUM' : 'LOW',
    }));

    res.status(200).json({ success: true, data: { users: result } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/whale/at-risk
export const getWhaleAtRisk = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(100, parseInt(qs(req.query.limit) ?? '10', 10));

    const segments = await prisma.spenderSegment.findMany({
      where: { segment: { in: ['WHALE', 'VIP'] }, fatigueScore: { gt: 0.5 } },
      orderBy: { fatigueScore: 'desc' },
      take: limit,
    }).catch(() => [] as any[]);

    const userIds = segments.map((s: any) => s.userId);
    const users   = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, lastSeen: true, profile: { select: { username: true } } },
    }).catch(() => [] as any[]);
    const userMap = Object.fromEntries(users.map((u: any) => [u.id, u]));

    const result = segments.map((s: any) => {
      const user     = userMap[s.userId];
      const lastSeen = user?.lastSeen ? new Date(user.lastSeen) : null;
      const daysSince = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 86400000) : 999;
      return {
        id:              s.userId,
        name:            user?.profile?.username ?? s.userId,
        churnRisk:       s.fatigueScore > 0.7 ? 'HIGH' : 'MEDIUM',
        daysSinceActive: daysSince,
      };
    });

    res.status(200).json({ success: true, data: { users: result } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/whale/ltv-distribution
export const getWhaleLtvDistribution = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const segments = await prisma.spenderSegment.findMany({
      select: { ltv: true, totalSpend: true },
    }).catch(() => [] as any[]);

    // Build LTV buckets
    const bucketDefs = [
      { label: '$0',      min: 0,    max: 1    },
      { label: '$1-10',   min: 1,    max: 10   },
      { label: '$10-50',  min: 10,   max: 50   },
      { label: '$50-100', min: 50,   max: 100  },
      { label: '$100-500', min: 100,  max: 500  },
      { label: '$500+',   min: 500,  max: Infinity },
    ];

    const total = segments.length;
    const buckets = bucketDefs.map(({ label, min, max }) => {
      const inBucket = segments.filter((s: any) => {
        const v = Number(s.ltv);
        return v >= min && v < max;
      });
      const revenue = inBucket.reduce((a: number, s: any) => a + Number(s.totalSpend), 0);
      return {
        label,
        count:   inBucket.length,
        pct:     total > 0 ? Math.round((inBucket.length / total) * 10000) / 100 : 0,
        revenue,
      };
    });

    res.status(200).json({ success: true, data: { buckets } });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/whale/segments
export const getWhaleSegments = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const segmentCounts = await prisma.spenderSegment.groupBy({
      by: ['segment'],
      _count:  { id: true },
      _sum:    { ltv: true },
      _avg:    { ltv: true },
    }).catch(() => [] as any[]);

    const data = segmentCounts.map((s: any) => ({
      segment:  s.segment,
      count:    s._count.id,
      totalLtv: Number(s._sum?.ltv ?? 0),
      avgLtv:   Number(s._avg?.ltv ?? 0),
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── Audit logs ────────────────────────────────────────────────────────────────

// GET /api/admin/audit
export const getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, pageSize, skip } = paginate(req.query);
    const adminId    = qs(req.query.adminId);
    const action     = qs(req.query.action);
    const targetType = qs(req.query.targetType);
    // Legacy cursor support
    const cursor     = qs(req.query.cursor);
    const take       = Math.min(100, pageSize);

    const where: any = {};
    if (adminId)    where.adminId    = adminId;
    if (action)     where.action     = action;
    if (targetType) where.targetType = targetType;
    if (cursor)     where.id         = { lt: cursor };

    const [logs, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    cursor ? 0 : skip,
        take,
        select: {
          id: true, adminId: true, action: true,
          targetType: true, targetId: true,
          metadata: true, requestId: true, createdAt: true,
        },
      }),
      prisma.adminAuditLog.count({ where: cursor ? {} : where }),
    ]);

    res.status(200).json({
      success: true,
      data: pageResponse(logs, total, page, pageSize),
      // Legacy cursor for backward compat
      meta: { count: logs.length, nextCursor: logs.length === take ? logs[take - 1]?.id : null },
    });
  } catch (error) {
    next(error);
  }
};

// ── System overview ────────────────────────────────────────────────────────────

// GET /api/admin/system/overview
export const getSystemOverview = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [
      totalUsers, totalMessages, totalLikes,
      totalChats, totalTransactions, totalMediaAssets,
      totalReports, activeFlags,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.message.count(),
      prisma.like.count(),
      prisma.chat.count(),
      prisma.transaction.count(),
      prisma.mediaAsset.count({ where: { status: 'READY' } }),
      prisma.report.count(),
      prisma.featureFlag.count({ where: { enabled: true } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalUsers, totalMessages, totalLikes,
        totalChats, totalTransactions, totalMediaAssets,
        totalReports, activeFlags,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/system/queues
export const listQueueNames = (_req: Request, res: Response): void => {
  res.status(200).json({ success: true, data: Object.keys(KNOWN_QUEUES) });
};

// ── Incident debugging ────────────────────────────────────────────────────────

// GET /api/admin/incident/search
export const searchIncident = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const requestId = qs(req.query.requestId) ?? '';
    if (!requestId) {
      res.status(400).json({ success: false, message: 'requestId is required' });
      return;
    }
    const events = await searchByRequestId(requestId);
    res.status(200).json({ success: true, data: events });
  } catch (error) {
    next(error);
  }
};
