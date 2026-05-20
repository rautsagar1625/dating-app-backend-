import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import {
  // ── Legacy dashboard ──────────────────────────────────────────────────────
  getDashboard,
  getTimeSeries,
  getSystemOverview,
  listQueueNames,
  // ── Overview (new) ────────────────────────────────────────────────────────
  getOverviewStats,
  getOverviewCharts,
  getOverviewAlerts,
  getOverviewQueues,
  // ── Users ─────────────────────────────────────────────────────────────────
  getUsers,
  getUserDetail,
  getUserInvestigation,
  getUserTimelineNew,
  getUserTimeline,
  getUserDevices,
  getUserPayments,
  getUserEnforcements,
  banUserNew,
  unbanUserNew,
  suspendUser,
  enforceUser,
  revokeEnforcement,
  banUser,                   // legacy
  // ── Moderation ────────────────────────────────────────────────────────────
  getModerationReports,
  getModerationReport,
  resolveModerationReport,
  assignReport,
  escalateReport,
  getAiFlags,
  reviewAiFlag,
  getAppeals,
  reviewAppeal,
  getModerationMedia,
  reviewModerationMedia,
  getModerationStats,
  getReports,               // legacy
  resolveReport,            // legacy
  getPendingMedia,          // legacy
  reviewMedia,              // legacy
  // ── Fraud ─────────────────────────────────────────────────────────────────
  getFraudStats,
  getFraudAlerts,
  getFraudPatterns,
  getIpBlocks,
  addIpBlock,
  removeIpBlock,
  fraudBulkAction,
  // ── Revenue ───────────────────────────────────────────────────────────────
  getRevenueOverview,
  getRevenueCharts,
  getRevenuePlans,
  getRevenueCohorts,
  // ── Analytics (legacy) ────────────────────────────────────────────────────
  getRetention,
  getRevenue,
  getFunnelData,
  triggerBackfill,
  // ── Payments ──────────────────────────────────────────────────────────────
  getPaymentStats,
  getPayments,
  getPaymentDetail,
  refundPayment,
  getPaymentDisputes,
  // ── Feature flags ─────────────────────────────────────────────────────────
  getFeatureFlags,
  createFeatureFlag,
  updateFeatureFlag,
  deleteFeatureFlag,
  // ── Queues ────────────────────────────────────────────────────────────────
  getQueues,
  getQueueJobs,
  getQueueFailedJobs,
  retryJobNew,
  retryJob,
  retryAllJobsInQueue,
  clearFailedJobs,
  pauseQueueHandler,
  resumeQueueHandler,
  drainQueueHandler,
  // ── Whale intelligence ────────────────────────────────────────────────────
  getWhaleOverview,
  getWhaleTopSpenders,
  getWhaleAtRisk,
  getWhaleLtvDistribution,
  getWhaleSegments,
  // ── Audit ─────────────────────────────────────────────────────────────────
  getAuditLogs,
  // ── Incident ─────────────────────────────────────────────────────────────
  searchIncident,
} from '../controllers/admin.controller';

const router = Router();

// All admin routes require authentication + admin/moderator/analyst role
router.use(requireAuth);
router.use(requireAdmin);

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard',             requirePermission('read:dashboard'),  getDashboard);
router.get('/dashboard/timeseries',  requirePermission('read:analytics'),  getTimeSeries);
router.get('/system/overview',       requirePermission('read:dashboard'),  getSystemOverview);
router.get('/system/queues',         requirePermission('read:queues'),     listQueueNames);

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW  — /api/admin/overview/*
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/overview/stats',   requirePermission('read:dashboard'),  getOverviewStats);
router.get('/overview/charts',  requirePermission('read:analytics'),  getOverviewCharts);
router.get('/overview/alerts',  requirePermission('read:dashboard'),  getOverviewAlerts);
router.get('/overview/queues',  requirePermission('read:queues'),     getOverviewQueues);

// ═══════════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT  — /api/admin/users/*
// ═══════════════════════════════════════════════════════════════════════════════

// Collection
router.get('/users',  requirePermission('read:users'),  getUsers);

// Per-user sub-resources  (order matters: specific paths before :id catch-all)
router.get('/users/:id/timeline',     requirePermission('read:users'),   getUserTimelineNew);
router.get('/users/:id/devices',      requirePermission('read:users'),   getUserDevices);
router.get('/users/:id/payments',     requirePermission('read:revenue'), getUserPayments);
router.get('/users/:id/enforcements', requirePermission('read:fraud'),   getUserEnforcements);

// Enforcement mutations
router.post('/users/:id/ban',                          requirePermission('write:users'),  banUserNew);
router.delete('/users/:id/ban',                        requirePermission('write:users'),  unbanUserNew);
router.post('/users/:id/suspend',                      requirePermission('write:users'),  suspendUser);
router.post('/users/:id/enforce',                      requirePermission('write:fraud'),  enforceUser);
router.delete('/users/:id/enforcements/:enforcementId', requirePermission('write:fraud'), revokeEnforcement);

// User detail (catch-all, must come after sub-resource routes)
router.get('/users/:id',  requirePermission('read:users'),  getUserDetail);

// ── Legacy user routes (kept for backward compat) ─────────────────────────────
router.get('/users/:userId/investigation',  requirePermission('read:users'),  getUserInvestigation);
router.get('/users/:userId/timeline',       requirePermission('read:users'),  getUserTimeline);
router.post('/ban/:userId',                 requirePermission('write:users'), banUser);

// ═══════════════════════════════════════════════════════════════════════════════
// MODERATION  — /api/admin/moderation/*
// ═══════════════════════════════════════════════════════════════════════════════

// Reports
router.get('/moderation/reports',              requirePermission('read:reports'),   getModerationReports);
router.get('/moderation/reports/:id',          requirePermission('read:reports'),   getModerationReport);
router.patch('/moderation/reports/:id/resolve', requirePermission('write:reports'), resolveModerationReport);
router.patch('/moderation/reports/:id/assign',  requirePermission('write:reports'), assignReport);
router.patch('/moderation/reports/:id/escalate', requirePermission('write:reports'), escalateReport);

// AI flags (backed by FraudCase)
router.get('/moderation/ai-flags',               requirePermission('read:fraud'),       getAiFlags);
router.patch('/moderation/ai-flags/:id/review',  requirePermission('write:moderation'), reviewAiFlag);

// Appeals
router.get('/moderation/appeals',               requirePermission('read:moderation'),   getAppeals);
router.patch('/moderation/appeals/:id/review',  requirePermission('write:moderation'), reviewAppeal);

// Media
router.get('/moderation/media',      requirePermission('read:reports'),  getModerationMedia);
router.patch('/moderation/media/:id', requirePermission('write:media'),  reviewModerationMedia);

// Stats
router.get('/moderation/stats',  requirePermission('read:reports'),  getModerationStats);

// ── Legacy moderation routes ──────────────────────────────────────────────────
router.get('/reports',                     requirePermission('read:reports'),   getReports);
router.post('/reports/:reportId/resolve',  requirePermission('write:reports'),  resolveReport);
router.get('/media',                       requirePermission('read:reports'),   getPendingMedia);
router.patch('/media/:assetId/review',     requirePermission('write:media'),    reviewMedia);

// ═══════════════════════════════════════════════════════════════════════════════
// FRAUD  — /api/admin/fraud/*
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/fraud/stats',          requirePermission('read:fraud'),   getFraudStats);
router.get('/fraud/alerts',         requirePermission('read:fraud'),   getFraudAlerts);
router.get('/fraud/patterns',       requirePermission('read:fraud'),   getFraudPatterns);
router.get('/fraud/ip-blocks',      requirePermission('read:fraud'),   getIpBlocks);
router.post('/fraud/ip-blocks',     requirePermission('write:fraud'),  addIpBlock);
router.delete('/fraud/ip-blocks/:ip', requirePermission('write:fraud'), removeIpBlock);
router.post('/fraud/bulk-action',   requirePermission('write:fraud'),  fraudBulkAction);

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE  — /api/admin/revenue/*
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/revenue/overview',  requirePermission('read:revenue'),    getRevenueOverview);
router.get('/revenue/charts',    requirePermission('read:revenue'),    getRevenueCharts);
router.get('/revenue/plans',     requirePermission('read:revenue'),    getRevenuePlans);
router.get('/revenue/cohorts',   requirePermission('read:analytics'),  getRevenueCohorts);

// ── Legacy analytics routes ───────────────────────────────────────────────────
router.get('/analytics/retention',    requirePermission('read:analytics'),  getRetention);
router.get('/analytics/revenue',      requirePermission('read:analytics'),  getRevenue);
router.get('/analytics/funnel',       requirePermission('read:analytics'),  getFunnelData);
router.post('/analytics/backfill',    requirePermission('write:queues'),    triggerBackfill);

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS  — /api/admin/payments/*
// NOTE: /payments/stats and /payments/disputes must come before /payments/:id
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/payments/stats',       requirePermission('read:revenue'),       getPaymentStats);
router.get('/payments/disputes',    requirePermission('read:revenue'),       getPaymentDisputes);
router.get('/payments',             requirePermission('read:revenue'),       getPayments);
router.get('/payments/:id',         requirePermission('read:revenue'),       getPaymentDetail);
router.post('/payments/:id/refund', requirePermission('write:monetization'), refundPayment);

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE FLAGS  — /api/admin/flags/*
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/flags',         requirePermission('read:flags'),   getFeatureFlags);
router.post('/flags',        requirePermission('write:flags'),  createFeatureFlag);
router.patch('/flags/:key',  requirePermission('write:flags'),  updateFeatureFlag);
router.delete('/flags/:key', requirePermission('write:flags'),  deleteFeatureFlag);

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUE MONITORING  — /api/admin/queues/*
// NOTE: named sub-paths must come before /:name catch-alls
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/queues',  requirePermission('read:queues'),  getQueues);

// Per-queue operations — specific routes first
router.get('/queues/:name/jobs',              requirePermission('read:queues'),   getQueueJobs);
router.get('/queues/:name/failed',            requirePermission('read:queues'),   getQueueFailedJobs);
router.post('/queues/:name/jobs/:jobId/retry', requirePermission('write:queues'), retryJobNew);
router.post('/queues/:name/retry/:jobId',     requirePermission('write:queues'),  retryJob);
router.post('/queues/:name/retry-all',        requirePermission('write:queues'),  retryAllJobsInQueue);
router.delete('/queues/:name/failed',         requirePermission('write:queues'),  clearFailedJobs);
router.post('/queues/:name/pause',            requirePermission('write:queues'),  pauseQueueHandler);
router.post('/queues/:name/resume',           requirePermission('write:queues'),  resumeQueueHandler);
router.post('/queues/:name/drain',            requirePermission('write:queues'),  drainQueueHandler);

// ═══════════════════════════════════════════════════════════════════════════════
// WHALE INTELLIGENCE  — /api/admin/whale/*
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/whale/overview',          requirePermission('read:revenue'),  getWhaleOverview);
router.get('/whale/top-spenders',      requirePermission('read:revenue'),  getWhaleTopSpenders);
router.get('/whale/at-risk',           requirePermission('read:revenue'),  getWhaleAtRisk);
router.get('/whale/ltv-distribution',  requirePermission('read:revenue'),  getWhaleLtvDistribution);
router.get('/whale/segments',          requirePermission('read:revenue'),  getWhaleSegments);

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG  — /api/admin/audit
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/audit',  requirePermission('read:dashboard'),  getAuditLogs);

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT DEBUGGING  — /api/admin/incident/*
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/incident/search',  requirePermission('read:dashboard'),  searchIncident);

export default router;
