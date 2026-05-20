-- DropForeignKey
ALTER TABLE "FraudCase" DROP CONSTRAINT "FraudCase_deviceFpId_fkey";

-- DropForeignKey
ALTER TABLE "FraudEnforcementAction" DROP CONSTRAINT "FraudEnforcementAction_deviceFpId_fkey";

-- DropForeignKey
ALTER TABLE "FraudSignal" DROP CONSTRAINT "FraudSignal_deviceFpId_fkey";

-- AlterTable
ALTER TABLE "DeviceFingerprint" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FeatureFlag" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FraudCase" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "voiceNoteId" TEXT;

-- AlterTable
ALTER TABLE "UserRiskProfile" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "moderationState" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "tempS3Key" TEXT,
    "cdnDomain" TEXT,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationSecs" DOUBLE PRECISION,
    "perceptualHash" TEXT,
    "sha256Hash" TEXT,
    "blurhash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaVariant" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "variantType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT,
    "uploadType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "presignedUrl" TEXT NOT NULL,
    "maxSizeBytes" INTEGER NOT NULL,
    "allowedMimes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaModeration" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "isNsfw" BOOLEAN,
    "nsfwScore" DOUBLE PRECISION,
    "labels" TEXT[],
    "reviewerId" TEXT,
    "reviewNotes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaModeration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationEvent" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerReason" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "moderatorId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationDecision" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "provider" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "signals" JSONB NOT NULL DEFAULT '[]',
    "enforcementType" TEXT,
    "enforcementId" TEXT,
    "moderatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageModerationResult" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL DEFAULT 'CLEAN',
    "signals" JSONB NOT NULL DEFAULT '[]',
    "contactsFound" BOOLEAN NOT NULL DEFAULT false,
    "langCode" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'rules',
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageModerationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationRiskProfile" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'CLEAN',
    "toxicMessages" INTEGER NOT NULL DEFAULT 0,
    "spamMessages" INTEGER NOT NULL DEFAULT 0,
    "escortSignals" INTEGER NOT NULL DEFAULT 0,
    "scamSignals" INTEGER NOT NULL DEFAULT 0,
    "contactExtracts" INTEGER NOT NULL DEFAULT 0,
    "harassSignals" INTEGER NOT NULL DEFAULT 0,
    "initiatorRisk" INTEGER NOT NULL DEFAULT 0,
    "recipientRisk" INTEGER NOT NULL DEFAULT 0,
    "lastSignalAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationRiskProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustScoreHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "components" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustScoreHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAppeal" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(500) NOT NULL,
    "reviewerId" TEXT,
    "reviewNotes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipHash" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardMetricSnapshot" (
    "id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "granularity" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsAggregation" (
    "id" TEXT NOT NULL,
    "aggType" TEXT NOT NULL,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "cohortDate" TIMESTAMP(3),
    "value" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsAggregation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAccessLog" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessType" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSignalProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "likeOutRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "likeInRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "replyRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgConvDepth" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "convStartRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "avgSessionLenS" INTEGER NOT NULL DEFAULT 0,
    "blockRecvRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reportRecvRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "profileQuality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "fraudScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSignalProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationCandidate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "poolType" TEXT NOT NULL,
    "preScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "seenCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "rankVersion" TEXT NOT NULL DEFAULT 'v1',
    "experimentId" TEXT,

    CONSTRAINT "FeedSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "sessionId" TEXT,
    "action" TEXT NOT NULL,
    "dwellMs" INTEGER,
    "position" INTEGER,
    "rankScore" DOUBLE PRECISION,
    "rankVersion" TEXT,
    "signals" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmbedding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'v0',
    "vector" JSONB NOT NULL,
    "dimensions" INTEGER NOT NULL DEFAULT 64,
    "modelName" TEXT NOT NULL DEFAULT 'behavioral_v0',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankingExperiment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "variants" JSONB NOT NULL,
    "trafficPct" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankingExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rankVersion" TEXT NOT NULL,
    "topN" JSONB NOT NULL,
    "weights" JSONB NOT NULL,

    CONSTRAINT "RecommendationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'audio/aac',
    "fileSizeBytes" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "waveform" JSONB NOT NULL,
    "transcription" TEXT,
    "processedAt" TIMESTAMP(3),
    "moderatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "calleeId" TEXT NOT NULL,
    "chatId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'AUDIO',
    "status" TEXT NOT NULL DEFAULT 'RINGING',
    "provider" TEXT NOT NULL DEFAULT 'stub',
    "providerRoomId" TEXT,
    "callerToken" TEXT,
    "calleeToken" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationS" INTEGER,
    "endReason" TEXT,
    "callerIpHash" TEXT,
    "calleeIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallParticipant" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "deviceType" TEXT,
    "appVersion" TEXT,

    CONSTRAINT "CallParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallQualityEvent" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packetLossPct" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "rttMs" DOUBLE PRECISION,
    "bitrateKbps" DOUBLE PRECISION,
    "resolution" TEXT,
    "frameRate" INTEGER,
    "networkType" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallQualityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallModerationEvent" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reportedId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" VARCHAR(500),
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallModerationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "provider" TEXT NOT NULL,
    "providerSubId" TEXT,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resumeAt" TIMESTAMP(3),
    "gracePeriodEndsAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "priceUsd" DECIMAL(10,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingInterval" TEXT NOT NULL DEFAULT 'MONTH',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "failedRenewals" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerIntentId" TEXT,
    "productType" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "amountUsd" DECIMAL(10,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "receiptData" TEXT,
    "refundedAt" TIMESTAMP(3),
    "refundAmountUsd" DECIMAL(10,4),
    "disputedAt" TIMESTAMP(3),
    "subscriptionId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "paymentSessionId" TEXT,
    "userId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "originalTransactionId" TEXT,
    "receiptToken" TEXT NOT NULL,
    "purchaseState" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "validatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validationResponse" JSONB,
    "subscriptionId" TEXT,
    "userId2" TEXT,

    CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoostCampaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "paymentSessionId" TEXT,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "impressionsCap" INTEGER,
    "impressionsSent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoostCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonetizationExperiment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "trafficPct" INTEGER NOT NULL DEFAULT 100,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonetizationExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferExposure" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerType" TEXT NOT NULL,
    "experimentId" TEXT,
    "variantId" TEXT,
    "context" TEXT,
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convertedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "revenue" DECIMAL(10,4),

    CONSTRAINT "OfferExposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueSnapshot" (
    "id" TEXT NOT NULL,
    "granularity" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalRevenue" DECIMAL(12,4) NOT NULL,
    "subscriptionRev" DECIMAL(12,4) NOT NULL,
    "boostRev" DECIMAL(12,4) NOT NULL,
    "creditPackRev" DECIMAL(12,4) NOT NULL,
    "newSubscribers" INTEGER NOT NULL DEFAULT 0,
    "churned" INTEGER NOT NULL DEFAULT 0,
    "arpu" DECIMAL(10,4),
    "activeSubCount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpenderSegment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "segment" TEXT NOT NULL DEFAULT 'FREE',
    "ltv" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "totalSpend" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "purchaseCount" INTEGER NOT NULL DEFAULT 0,
    "lastPurchaseAt" TIMESTAMP(3),
    "fatigueScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendingRiskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "segmentUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpenderSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAsset_userId_mediaType_status_idx" ON "MediaAsset"("userId", "mediaType", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_perceptualHash_idx" ON "MediaAsset"("perceptualHash");

-- CreateIndex
CREATE INDEX "MediaAsset_status_moderationState_idx" ON "MediaAsset"("status", "moderationState");

-- CreateIndex
CREATE INDEX "MediaAsset_userId_createdAt_idx" ON "MediaAsset"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MediaVariant_assetId_idx" ON "MediaVariant"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVariant_assetId_variantType_format_key" ON "MediaVariant"("assetId", "variantType", "format");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_assetId_key" ON "UploadSession"("assetId");

-- CreateIndex
CREATE INDEX "UploadSession_userId_status_idx" ON "UploadSession"("userId", "status");

-- CreateIndex
CREATE INDEX "UploadSession_expiresAt_idx" ON "UploadSession"("expiresAt");

-- CreateIndex
CREATE INDEX "MediaModeration_assetId_idx" ON "MediaModeration"("assetId");

-- CreateIndex
CREATE INDEX "MediaModeration_isNsfw_createdAt_idx" ON "MediaModeration"("isNsfw", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationEvent_userId_createdAt_idx" ON "ModerationEvent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationEvent_sourceType_sourceId_idx" ON "ModerationEvent"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ModerationEvent_decision_createdAt_idx" ON "ModerationEvent"("decision", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationEvent_triggerType_createdAt_idx" ON "ModerationEvent"("triggerType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationDecision_eventId_idx" ON "ModerationDecision"("eventId");

-- CreateIndex
CREATE INDEX "ModerationDecision_decision_createdAt_idx" ON "ModerationDecision"("decision", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationDecision_provider_createdAt_idx" ON "ModerationDecision"("provider", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MessageModerationResult_messageId_key" ON "MessageModerationResult"("messageId");

-- CreateIndex
CREATE INDEX "MessageModerationResult_userId_processedAt_idx" ON "MessageModerationResult"("userId", "processedAt" DESC);

-- CreateIndex
CREATE INDEX "MessageModerationResult_chatId_processedAt_idx" ON "MessageModerationResult"("chatId", "processedAt" DESC);

-- CreateIndex
CREATE INDEX "MessageModerationResult_riskScore_idx" ON "MessageModerationResult"("riskScore" DESC);

-- CreateIndex
CREATE INDEX "MessageModerationResult_decision_processedAt_idx" ON "MessageModerationResult"("decision", "processedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationRiskProfile_chatId_key" ON "ConversationRiskProfile"("chatId");

-- CreateIndex
CREATE INDEX "ConversationRiskProfile_riskScore_idx" ON "ConversationRiskProfile"("riskScore" DESC);

-- CreateIndex
CREATE INDEX "ConversationRiskProfile_riskLevel_idx" ON "ConversationRiskProfile"("riskLevel");

-- CreateIndex
CREATE INDEX "ConversationRiskProfile_lastSignalAt_idx" ON "ConversationRiskProfile"("lastSignalAt" DESC);

-- CreateIndex
CREATE INDEX "TrustScoreHistory_userId_createdAt_idx" ON "TrustScoreHistory"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TrustScoreHistory_score_idx" ON "TrustScoreHistory"("score" ASC);

-- CreateIndex
CREATE INDEX "ModerationAppeal_userId_createdAt_idx" ON "ModerationAppeal"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationAppeal_status_createdAt_idx" ON "ModerationAppeal"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminId_createdAt_idx" ON "AdminAuditLog"("adminId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "DashboardMetricSnapshot_metric_granularity_periodStart_idx" ON "DashboardMetricSnapshot"("metric", "granularity", "periodStart" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DashboardMetricSnapshot_metric_granularity_periodStart_key" ON "DashboardMetricSnapshot"("metric", "granularity", "periodStart");

-- CreateIndex
CREATE INDEX "AnalyticsAggregation_aggType_periodDate_idx" ON "AnalyticsAggregation"("aggType", "periodDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsAggregation_aggType_periodDate_cohortDate_key" ON "AnalyticsAggregation"("aggType", "periodDate", "cohortDate");

-- CreateIndex
CREATE INDEX "MediaAccessLog_assetId_createdAt_idx" ON "MediaAccessLog"("assetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MediaAccessLog_userId_createdAt_idx" ON "MediaAccessLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UserSignalProfile_userId_key" ON "UserSignalProfile"("userId");

-- CreateIndex
CREATE INDEX "UserSignalProfile_updatedAt_idx" ON "UserSignalProfile"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationCandidate_userId_expiresAt_idx" ON "RecommendationCandidate"("userId", "expiresAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationCandidate_userId_preScore_idx" ON "RecommendationCandidate"("userId", "preScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationCandidate_userId_candidateId_key" ON "RecommendationCandidate"("userId", "candidateId");

-- CreateIndex
CREATE INDEX "FeedSession_userId_startedAt_idx" ON "FeedSession"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "FeedSession_experimentId_startedAt_idx" ON "FeedSession"("experimentId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationFeedback_userId_occurredAt_idx" ON "RecommendationFeedback"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationFeedback_targetId_occurredAt_idx" ON "RecommendationFeedback"("targetId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationFeedback_action_occurredAt_idx" ON "RecommendationFeedback"("action", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationFeedback_sessionId_idx" ON "RecommendationFeedback"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "UserEmbedding_userId_key" ON "UserEmbedding"("userId");

-- CreateIndex
CREATE INDEX "UserEmbedding_version_computedAt_idx" ON "UserEmbedding"("version", "computedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RankingExperiment_name_key" ON "RankingExperiment"("name");

-- CreateIndex
CREATE INDEX "RankingExperiment_status_startedAt_idx" ON "RankingExperiment"("status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "RecommendationSnapshot_userId_snapshotAt_idx" ON "RecommendationSnapshot"("userId", "snapshotAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceMessage_messageId_key" ON "VoiceMessage"("messageId");

-- CreateIndex
CREATE INDEX "VoiceMessage_chatId_createdAt_idx" ON "VoiceMessage"("chatId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VoiceMessage_senderId_createdAt_idx" ON "VoiceMessage"("senderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallSession_callerId_createdAt_idx" ON "CallSession"("callerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallSession_calleeId_createdAt_idx" ON "CallSession"("calleeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallSession_status_createdAt_idx" ON "CallSession"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallSession_chatId_createdAt_idx" ON "CallSession"("chatId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallParticipant_userId_joinedAt_idx" ON "CallParticipant"("userId", "joinedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "CallParticipant_callId_userId_key" ON "CallParticipant"("callId", "userId");

-- CreateIndex
CREATE INDEX "CallQualityEvent_callId_reportedAt_idx" ON "CallQualityEvent"("callId", "reportedAt" DESC);

-- CreateIndex
CREATE INDEX "CallQualityEvent_userId_reportedAt_idx" ON "CallQualityEvent"("userId", "reportedAt" DESC);

-- CreateIndex
CREATE INDEX "CallModerationEvent_callId_idx" ON "CallModerationEvent"("callId");

-- CreateIndex
CREATE INDEX "CallModerationEvent_reportedId_createdAt_idx" ON "CallModerationEvent"("reportedId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CallModerationEvent_status_createdAt_idx" ON "CallModerationEvent"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubId_key" ON "Subscription"("providerSubId");

-- CreateIndex
CREATE INDEX "Subscription_userId_status_idx" ON "Subscription"("userId", "status");

-- CreateIndex
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "Subscription_providerSubId_idx" ON "Subscription"("providerSubId");

-- CreateIndex
CREATE INDEX "SubscriptionEntitlement_userId_expiresAt_idx" ON "SubscriptionEntitlement"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "SubscriptionEntitlement_subscriptionId_idx" ON "SubscriptionEntitlement"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEntitlement_userId_feature_key" ON "SubscriptionEntitlement"("userId", "feature");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSession_idempotencyKey_key" ON "PaymentSession"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSession_providerIntentId_key" ON "PaymentSession"("providerIntentId");

-- CreateIndex
CREATE INDEX "PaymentSession_userId_status_idx" ON "PaymentSession"("userId", "status");

-- CreateIndex
CREATE INDEX "PaymentSession_status_createdAt_idx" ON "PaymentSession"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PaymentSession_providerIntentId_idx" ON "PaymentSession"("providerIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderEvent_providerEventId_key" ON "PaymentProviderEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_provider_eventType_idx" ON "PaymentProviderEvent"("provider", "eventType");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_paymentSessionId_idx" ON "PaymentProviderEvent"("paymentSessionId");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_processedAt_idx" ON "PaymentProviderEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceipt_transactionId_key" ON "PurchaseReceipt"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReceipt_subscriptionId_key" ON "PurchaseReceipt"("subscriptionId");

-- CreateIndex
CREATE INDEX "PurchaseReceipt_userId_platform_idx" ON "PurchaseReceipt"("userId", "platform");

-- CreateIndex
CREATE INDEX "PurchaseReceipt_originalTransactionId_idx" ON "PurchaseReceipt"("originalTransactionId");

-- CreateIndex
CREATE INDEX "BoostCampaign_userId_status_idx" ON "BoostCampaign"("userId", "status");

-- CreateIndex
CREATE INDEX "BoostCampaign_status_expiresAt_idx" ON "BoostCampaign"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonetizationExperiment_name_key" ON "MonetizationExperiment"("name");

-- CreateIndex
CREATE INDEX "MonetizationExperiment_status_idx" ON "MonetizationExperiment"("status");

-- CreateIndex
CREATE INDEX "PricingVariant_experimentId_idx" ON "PricingVariant"("experimentId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingVariant_experimentId_name_key" ON "PricingVariant"("experimentId", "name");

-- CreateIndex
CREATE INDEX "OfferExposure_userId_offerType_idx" ON "OfferExposure"("userId", "offerType");

-- CreateIndex
CREATE INDEX "OfferExposure_offerType_shownAt_idx" ON "OfferExposure"("offerType", "shownAt" DESC);

-- CreateIndex
CREATE INDEX "OfferExposure_experimentId_shownAt_idx" ON "OfferExposure"("experimentId", "shownAt");

-- CreateIndex
CREATE INDEX "RevenueSnapshot_granularity_periodStart_idx" ON "RevenueSnapshot"("granularity", "periodStart" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RevenueSnapshot_granularity_periodStart_currency_key" ON "RevenueSnapshot"("granularity", "periodStart", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "SpenderSegment_userId_key" ON "SpenderSegment"("userId");

-- CreateIndex
CREATE INDEX "SpenderSegment_segment_idx" ON "SpenderSegment"("segment");

-- CreateIndex
CREATE INDEX "SpenderSegment_ltv_idx" ON "SpenderSegment"("ltv" DESC);

-- CreateIndex
CREATE INDEX "Message_type_chatId_idx" ON "Message"("type", "chatId");

-- AddForeignKey
ALTER TABLE "FraudSignal" ADD CONSTRAINT "FraudSignal_deviceFpId_fkey" FOREIGN KEY ("deviceFpId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudCase" ADD CONSTRAINT "FraudCase_deviceFpId_fkey" FOREIGN KEY ("deviceFpId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudEnforcementAction" ADD CONSTRAINT "FraudEnforcementAction_deviceFpId_fkey" FOREIGN KEY ("deviceFpId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaVariant" ADD CONSTRAINT "MediaVariant_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaModeration" ADD CONSTRAINT "MediaModeration_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationDecision" ADD CONSTRAINT "ModerationDecision_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ModerationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationRiskProfile" ADD CONSTRAINT "ConversationRiskProfile_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAppeal" ADD CONSTRAINT "ModerationAppeal_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ModerationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAccessLog" ADD CONSTRAINT "MediaAccessLog_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_callId_fkey" FOREIGN KEY ("callId") REFERENCES "CallSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallQualityEvent" ADD CONSTRAINT "CallQualityEvent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "CallSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallModerationEvent" ADD CONSTRAINT "CallModerationEvent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "CallSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEntitlement" ADD CONSTRAINT "SubscriptionEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEntitlement" ADD CONSTRAINT "SubscriptionEntitlement_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSession" ADD CONSTRAINT "PaymentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSession" ADD CONSTRAINT "PaymentSession_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProviderEvent" ADD CONSTRAINT "PaymentProviderEvent_paymentSessionId_fkey" FOREIGN KEY ("paymentSessionId") REFERENCES "PaymentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReceipt" ADD CONSTRAINT "PurchaseReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoostCampaign" ADD CONSTRAINT "BoostCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingVariant" ADD CONSTRAINT "PricingVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "MonetizationExperiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferExposure" ADD CONSTRAINT "OfferExposure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferExposure" ADD CONSTRAINT "OfferExposure_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "MonetizationExperiment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferExposure" ADD CONSTRAINT "OfferExposure_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "PricingVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpenderSegment" ADD CONSTRAINT "SpenderSegment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "FeatureFlagAuditLog_flagId_crAt_idx" RENAME TO "FeatureFlagAuditLog_flagId_createdAt_idx";

-- RenameIndex
ALTER INDEX "FraudEnforcementAction_devFp_active_idx" RENAME TO "FraudEnforcementAction_deviceFpId_isActive_idx";

-- RenameIndex
ALTER INDEX "FraudEnforcementAction_type_active_idx" RENAME TO "FraudEnforcementAction_actionType_isActive_idx";

-- RenameIndex
ALTER INDEX "FraudEnforcementAction_userId_active_idx" RENAME TO "FraudEnforcementAction_userId_isActive_idx";
