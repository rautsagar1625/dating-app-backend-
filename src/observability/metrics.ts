import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ app: 'velvet-api', env: process.env.NODE_ENV || 'development' });

collectDefaultMetrics({ register: registry, prefix: 'velvet_node_' });

// ── HTTP ─────────────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'velvet_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: 'velvet_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpErrorTotal = new Counter({
  name: 'velvet_http_errors_total',
  help: 'Total HTTP 5xx errors',
  labelNames: ['method', 'route'],
  registers: [registry],
});

export const httpPayloadSize = new Histogram({
  name: 'velvet_http_request_payload_bytes',
  help: 'Request payload size in bytes',
  labelNames: ['method', 'route'],
  buckets: [100, 1024, 10240, 51200, 102400, 512000, 1048576, 2097152],
  registers: [registry],
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

export const wsConnectionsGauge = new Gauge({
  name: 'velvet_ws_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [registry],
});

export const wsOnlineUsersGauge = new Gauge({
  name: 'velvet_ws_online_users',
  help: 'Number of users currently marked online',
  registers: [registry],
});

export const wsMessagesTotal = new Counter({
  name: 'velvet_ws_messages_total',
  help: 'Total WebSocket messages processed',
  labelNames: ['event'],
  registers: [registry],
});

export const wsDisconnectTotal = new Counter({
  name: 'velvet_ws_disconnects_total',
  help: 'Total WebSocket disconnections by reason',
  labelNames: ['reason'],
  registers: [registry],
});

export const wsReconnectTotal = new Counter({
  name: 'velvet_ws_reconnects_total',
  help: 'Reconnects within the 30s grace period',
  registers: [registry],
});

// ── Queue ─────────────────────────────────────────────────────────────────────

export const queueJobsProcessedTotal = new Counter({
  name: 'velvet_queue_jobs_processed_total',
  help: 'Total queue jobs completed',
  labelNames: ['queue', 'status'],
  registers: [registry],
});

export const queueJobDuration = new Histogram({
  name: 'velvet_queue_job_duration_seconds',
  help: 'Queue job processing duration in seconds',
  labelNames: ['queue'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const queueDepthGauge = new Gauge({
  name: 'velvet_queue_depth',
  help: 'Number of waiting jobs in queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const queueFailedJobsTotal = new Counter({
  name: 'velvet_queue_failed_jobs_total',
  help: 'Total jobs that exhausted all retry attempts',
  labelNames: ['queue'],
  registers: [registry],
});

// ── Database ──────────────────────────────────────────────────────────────────

export const dbQueryDuration = new Histogram({
  name: 'velvet_db_query_duration_seconds',
  help: 'Prisma query execution time in seconds',
  labelNames: ['operation', 'model'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const dbSlowQueryTotal = new Counter({
  name: 'velvet_db_slow_queries_total',
  help: 'Queries exceeding the slow-query threshold (100ms)',
  labelNames: ['operation', 'model'],
  registers: [registry],
});

// ── Application ───────────────────────────────────────────────────────────────

export const authAttemptsTotal = new Counter({
  name: 'velvet_auth_attempts_total',
  help: 'Authentication attempts',
  labelNames: ['type', 'result'],
  registers: [registry],
});

export const notificationsSentTotal = new Counter({
  name: 'velvet_notifications_sent_total',
  help: 'Notifications sent by type',
  labelNames: ['type'],
  registers: [registry],
});

export const spamFlaggedTotal = new Counter({
  name: 'velvet_spam_flagged_total',
  help: 'Messages rejected as spam',
  registers: [registry],
});

export const softBanTotal = new Counter({
  name: 'velvet_users_soft_banned_total',
  help: 'Users automatically soft-banned by risk engine',
  registers: [registry],
});

export const creditTransactionTotal = new Counter({
  name: 'velvet_credit_transactions_total',
  help: 'Credit debit transactions by type',
  labelNames: ['type'],
  registers: [registry],
});

// ── Media pipeline ────────────────────────────────────────────────────────────

export const mediaUploadTotal = new Counter({
  name: 'velvet_media_uploads_total',
  help: 'Media upload outcomes by type and result',
  labelNames: ['mediaType', 'result'],
  registers: [registry],
});

export const mediaProcessingDuration = new Histogram({
  name: 'velvet_media_processing_duration_seconds',
  help: 'Duration of image processing pipeline stages',
  labelNames: ['stage'],
  // sharp processing: expect 0.1–2s depending on image size and variant count
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const mediaModerationTotal = new Counter({
  name: 'velvet_media_moderation_total',
  help: 'Moderation scan outcomes by provider and result',
  labelNames: ['provider', 'result'],
  registers: [registry],
});

export const mediaVariantSizeBytes = new Histogram({
  name: 'velvet_media_variant_size_bytes',
  help: 'Processed image variant file size in bytes',
  labelNames: ['variantType', 'format'],
  buckets: [1024, 10240, 51200, 102400, 307200, 512000, 1048576, 2097152],
  registers: [registry],
});

export const mediaQueueDepth = new Gauge({
  name: 'velvet_media_queue_depth',
  help: 'Number of waiting jobs in media queues',
  labelNames: ['queue'],
  registers: [registry],
});

export const mediaAccessTotal = new Counter({
  name: 'velvet_media_signed_url_issued_total',
  help: 'Signed CDN URLs issued by media type',
  labelNames: ['mediaType'],
  registers: [registry],
});

// ── Moderation ────────────────────────────────────────────────────────────────

export const moderationMessageTotal = new Counter({
  name: 'velvet_moderation_messages_total',
  help: 'Async text moderation outcomes by decision and provider',
  labelNames: ['decision', 'provider'],
  registers: [registry],
});

export const moderationEnforcementTotal = new Counter({
  name: 'velvet_moderation_enforcement_total',
  help: 'Enforcement actions applied by tier',
  labelNames: ['type'],
  registers: [registry],
});

export const moderationConvEscalationTotal = new Counter({
  name: 'velvet_moderation_conv_escalations_total',
  help: 'Conversations escalated to HIGH risk by detected pattern',
  labelNames: ['pattern'],
  registers: [registry],
});

export const moderationProviderDuration = new Histogram({
  name: 'velvet_moderation_provider_duration_seconds',
  help: 'Text/NSFW moderation provider response time',
  labelNames: ['provider'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const moderationAppealTotal = new Counter({
  name: 'velvet_moderation_appeals_total',
  help: 'Moderation appeals by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

export const moderationRealtimeTotal = new Counter({
  name: 'velvet_moderation_realtime_total',
  help: 'Realtime message moderation outcomes',
  labelNames: ['action'],
  registers: [registry],
});

// ── Recommendation engine ─────────────────────────────────────────────────────

export const recFeedGenerationDuration = new Histogram({
  name: 'velvet_rec_feed_generation_seconds',
  help: 'Time to build a ranked feed from scratch',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const recCandidatePoolSize = new Histogram({
  name: 'velvet_rec_candidate_pool_size',
  help: 'Number of candidates before ranking',
  buckets: [10, 25, 50, 100, 150, 200, 300],
  registers: [registry],
});

export const recFeedCacheHit = new Counter({
  name: 'velvet_rec_feed_cache_total',
  help: 'Feed requests served from cache vs rebuilt',
  labelNames: ['hit'],
  registers: [registry],
});

export const recFeedbackTotal = new Counter({
  name: 'velvet_rec_feedback_total',
  help: 'Recommendation feedback actions by type',
  labelNames: ['action'],
  registers: [registry],
});

export const recLikeConversionTotal = new Counter({
  name: 'velvet_rec_like_conversion_total',
  help: 'Like → match → conversation conversion events',
  labelNames: ['type'],
  registers: [registry],
});

export const recRankingLatency = new Histogram({
  name: 'velvet_rec_ranking_latency_seconds',
  help: 'Per-candidate scoring latency',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const recExperimentAssignments = new Counter({
  name: 'velvet_rec_experiment_assignments_total',
  help: 'Users assigned to ranking experiments by variant',
  labelNames: ['experimentId', 'variant'],
  registers: [registry],
});

export const recFatigueSuppressions = new Counter({
  name: 'velvet_rec_fatigue_suppressions_total',
  help: 'Candidates removed from feed due to fatigue',
  registers: [registry],
});

// ── Calls ─────────────────────────────────────────────────────────────────────

export const callInitiatedTotal = new Counter({
  name: 'velvet_call_initiated_total',
  help: 'Calls initiated by type and provider',
  labelNames: ['type', 'provider'],
  registers: [registry],
});

export const callStateTransitions = new Counter({
  name: 'velvet_call_state_transitions_total',
  help: 'Call state machine transitions by transition and provider',
  labelNames: ['transition', 'provider'],
  registers: [registry],
});

export const callDurationHistogram = new Histogram({
  name: 'velvet_call_duration_seconds',
  help: 'Call duration in seconds by type and provider',
  labelNames: ['type', 'provider'],
  buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [registry],
});

export const callSafetyBlocked = new Counter({
  name: 'velvet_call_safety_blocked_total',
  help: 'Calls blocked by safety check reason',
  labelNames: ['reason'],
  registers: [registry],
});

export const callQosPacketLoss = new Histogram({
  name: 'velvet_call_qos_packet_loss_pct',
  help: 'Client-reported packet loss percentage',
  labelNames: ['userId'],
  buckets: [0, 1, 2, 5, 10, 15, 20, 30, 50, 100],
  registers: [registry],
});

export const callQosJitter = new Histogram({
  name: 'velvet_call_qos_jitter_ms',
  help: 'Client-reported jitter in milliseconds',
  labelNames: ['userId'],
  buckets: [5, 10, 20, 30, 50, 80, 100, 150, 200, 500],
  registers: [registry],
});

export const callQosRtt = new Histogram({
  name: 'velvet_call_qos_rtt_ms',
  help: 'Client-reported round-trip time in milliseconds',
  labelNames: ['userId'],
  buckets: [10, 25, 50, 75, 100, 150, 200, 300, 500, 1000],
  registers: [registry],
});

// ── Voice notes ───────────────────────────────────────────────────────────────

export const voiceNoteProcessTotal = new Counter({
  name: 'velvet_voice_note_process_total',
  help: 'Voice note processing outcomes by result and ffmpeg availability',
  labelNames: ['result', 'ffmpeg'],
  registers: [registry],
});

export const voiceNoteProcessDuration = new Histogram({
  name: 'velvet_voice_note_process_duration_seconds',
  help: 'Voice note transcoding + waveform generation duration',
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

// ── Payments ──────────────────────────────────────────────────────────────────

export const paymentIntentTotal = new Counter({
  name: 'velvet_payment_intents_total',
  help: 'Payment intents created by provider and product type',
  labelNames: ['provider', 'productType'],
  registers: [registry],
});

export const paymentSuccessTotal = new Counter({
  name: 'velvet_payment_success_total',
  help: 'Successful payments by provider and product type',
  labelNames: ['provider', 'productType'],
  registers: [registry],
});

export const paymentFailureTotal = new Counter({
  name: 'velvet_payment_failure_total',
  help: 'Failed payments by provider, product type, and failure reason',
  labelNames: ['provider', 'productType', 'reason'],
  registers: [registry],
});

export const paymentLatency = new Histogram({
  name: 'velvet_payment_latency_seconds',
  help: 'Payment provider round-trip latency',
  labelNames: ['provider', 'productType'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const paymentWebhookTotal = new Counter({
  name: 'velvet_payment_webhook_total',
  help: 'Payment provider webhooks received by provider and event type',
  labelNames: ['provider', 'eventType'],
  registers: [registry],
});

export const paymentRefundTotal = new Counter({
  name: 'velvet_payment_refunds_total',
  help: 'Payment refunds by provider',
  labelNames: ['provider'],
  registers: [registry],
});

export const paymentReconcileTotal = new Counter({
  name: 'velvet_payment_reconcile_total',
  help: 'Reconciliation run outcomes',
  labelNames: ['resolved', 'total'],
  registers: [registry],
});

export const paymentDisputeTotal = new Counter({
  name: 'velvet_payment_disputes_total',
  help: 'Payment disputes / chargebacks received',
  labelNames: ['provider'],
  registers: [registry],
});

// ── Subscriptions ─────────────────────────────────────────────────────────────

export const subscriptionActivatedTotal = new Counter({
  name: 'velvet_subscription_activated_total',
  help: 'Subscriptions activated by tier and provider',
  labelNames: ['tier', 'provider'],
  registers: [registry],
});

export const subscriptionCancelledTotal = new Counter({
  name: 'velvet_subscription_cancelled_total',
  help: 'Subscriptions cancelled (immediately or at period end)',
  labelNames: ['immediately'],
  registers: [registry],
});

export const subscriptionExpiredTotal = new Counter({
  name: 'velvet_subscription_expired_total',
  help: 'Subscriptions that expired without renewal',
  registers: [registry],
});

export const subscriptionPastDueTotal = new Counter({
  name: 'velvet_subscription_past_due_total',
  help: 'Subscriptions that entered the past-due grace period',
  registers: [registry],
});

export const activeSubscriptionsGauge = new Gauge({
  name: 'velvet_active_subscriptions',
  help: 'Current count of active (non-expired) subscriptions',
  labelNames: ['tier'],
  registers: [registry],
});

// ── Entitlements ──────────────────────────────────────────────────────────────

export const entitlementCacheHit = new Counter({
  name: 'velvet_entitlement_cache_hits_total',
  help: 'Entitlement cache hits (Redis served)',
  registers: [registry],
});

export const entitlementCacheMiss = new Counter({
  name: 'velvet_entitlement_cache_misses_total',
  help: 'Entitlement cache misses (DB rebuild)',
  registers: [registry],
});

export const entitlementCheckTotal = new Counter({
  name: 'velvet_entitlement_checks_total',
  help: 'Feature entitlement checks by feature name',
  labelNames: ['feature'],
  registers: [registry],
});

// ── Boosts ────────────────────────────────────────────────────────────────────

export const boostActivatedTotal = new Counter({
  name: 'velvet_boost_activated_total',
  help: 'Boosts activated by type',
  labelNames: ['type'],
  registers: [registry],
});

export const boostExpiredTotal = new Counter({
  name: 'velvet_boost_expired_total',
  help: 'Boosts that expired or were exhausted',
  registers: [registry],
});

export const boostImpressionTotal = new Counter({
  name: 'velvet_boost_impressions_total',
  help: 'Profile impressions served during active boost',
  labelNames: ['type'],
  registers: [registry],
});

// ── Offers & behavioral monetization ─────────────────────────────────────────

export const offerShownTotal = new Counter({
  name: 'velvet_offer_shown_total',
  help: 'Monetization offers shown to users by type and context',
  labelNames: ['offerType', 'context'],
  registers: [registry],
});

export const offerConversionTotal = new Counter({
  name: 'velvet_offer_conversion_total',
  help: 'Monetization offers that resulted in a purchase',
  labelNames: ['offerType'],
  registers: [registry],
});

export const offerDismissedTotal = new Counter({
  name: 'velvet_offer_dismissed_total',
  help: 'Monetization offers dismissed by users',
  labelNames: ['offerType'],
  registers: [registry],
});

// ── Whale intelligence ────────────────────────────────────────────────────────

export const whaleSegmentUpdatedTotal = new Counter({
  name: 'velvet_whale_segment_updated_total',
  help: 'Spender segment recomputations by resulting segment',
  labelNames: ['segment'],
  registers: [registry],
});

// ── Revenue analytics ─────────────────────────────────────────────────────────

export const revenueSnapshotCreatedTotal = new Counter({
  name: 'velvet_revenue_snapshot_created_total',
  help: 'Revenue snapshots computed by granularity',
  labelNames: ['granularity'],
  registers: [registry],
});

export const monetizationExperimentAssignment = new Counter({
  name: 'velvet_monetization_experiment_assignments_total',
  help: 'Monetization experiment variant assignments by experiment and variant',
  labelNames: ['experimentId', 'variant'],
  registers: [registry],
});
