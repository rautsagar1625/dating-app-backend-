-- CreateTable: DeviceFingerprint
CREATE TABLE "DeviceFingerprint" (
    "id"             TEXT         NOT NULL,
    "deviceIdHash"   TEXT         NOT NULL,
    "brand"          TEXT,
    "model"          TEXT,
    "osName"         TEXT,
    "osVersion"      TEXT,
    "isEmulator"     BOOLEAN      NOT NULL DEFAULT false,
    "isRooted"       BOOLEAN      NOT NULL DEFAULT false,
    "riskScore"      INTEGER      NOT NULL DEFAULT 0,
    "riskLevel"      TEXT         NOT NULL DEFAULT 'CLEAN',
    "linkedUserIds"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "recentIpHashes" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "seenCount"      INTEGER      NOT NULL DEFAULT 1,
    "firstSeenAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FraudSignal
CREATE TABLE "FraudSignal" (
    "id"          TEXT         NOT NULL,
    "deviceFpId"  TEXT,
    "userId"      TEXT,
    "signalType"  TEXT         NOT NULL,
    "severity"    TEXT         NOT NULL,
    "score"       INTEGER      NOT NULL,
    "metadata"    JSONB        NOT NULL DEFAULT '{}',
    "resolvedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FraudSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FraudCase
CREATE TABLE "FraudCase" (
    "id"          TEXT         NOT NULL,
    "userId"      TEXT         NOT NULL,
    "deviceFpId"  TEXT,
    "status"      TEXT         NOT NULL DEFAULT 'PENDING',
    "priority"    TEXT         NOT NULL DEFAULT 'NORMAL',
    "riskScore"   INTEGER      NOT NULL,
    "signals"     JSONB        NOT NULL DEFAULT '[]',
    "reviewerId"  TEXT,
    "reviewNotes" TEXT,
    "actionTaken" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"  TIMESTAMP(3),
    CONSTRAINT "FraudCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FraudEnforcementAction
CREATE TABLE "FraudEnforcementAction" (
    "id"          TEXT         NOT NULL,
    "userId"      TEXT,
    "deviceFpId"  TEXT,
    "actionType"  TEXT         NOT NULL,
    "reason"      TEXT         NOT NULL,
    "expiresAt"   TIMESTAMP(3),
    "isActive"    BOOLEAN      NOT NULL DEFAULT true,
    "actorId"     TEXT,
    "metadata"    JSONB        NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"   TIMESTAMP(3),
    "revokedBy"   TEXT,
    CONSTRAINT "FraudEnforcementAction_pkey" PRIMARY KEY ("id")
);

-- Unique + regular indexes
CREATE UNIQUE INDEX "DeviceFingerprint_deviceIdHash_key" ON "DeviceFingerprint"("deviceIdHash");
CREATE INDEX "DeviceFingerprint_riskLevel_idx"           ON "DeviceFingerprint"("riskLevel");
CREATE INDEX "DeviceFingerprint_lastSeenAt_idx"          ON "DeviceFingerprint"("lastSeenAt" DESC);
CREATE INDEX "DeviceFingerprint_riskScore_idx"           ON "DeviceFingerprint"("riskScore" DESC);
CREATE INDEX "FraudSignal_userId_createdAt_idx"          ON "FraudSignal"("userId","createdAt" DESC);
CREATE INDEX "FraudSignal_deviceFpId_createdAt_idx"      ON "FraudSignal"("deviceFpId","createdAt" DESC);
CREATE INDEX "FraudSignal_signalType_createdAt_idx"      ON "FraudSignal"("signalType","createdAt" DESC);
CREATE INDEX "FraudCase_status_priority_createdAt_idx"   ON "FraudCase"("status","priority","createdAt" DESC);
CREATE INDEX "FraudCase_userId_idx"                      ON "FraudCase"("userId");
CREATE INDEX "FraudEnforcementAction_userId_active_idx"  ON "FraudEnforcementAction"("userId","isActive");
CREATE INDEX "FraudEnforcementAction_devFp_active_idx"   ON "FraudEnforcementAction"("deviceFpId","isActive");
CREATE INDEX "FraudEnforcementAction_type_active_idx"    ON "FraudEnforcementAction"("actionType","isActive");
CREATE INDEX "FraudEnforcementAction_expiresAt_idx"      ON "FraudEnforcementAction"("expiresAt");

-- Foreign keys (soft — no FK to User to allow deletion without cascade)
ALTER TABLE "FraudSignal"
    ADD CONSTRAINT "FraudSignal_deviceFpId_fkey"
    FOREIGN KEY ("deviceFpId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL;

ALTER TABLE "FraudCase"
    ADD CONSTRAINT "FraudCase_deviceFpId_fkey"
    FOREIGN KEY ("deviceFpId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL;

ALTER TABLE "FraudEnforcementAction"
    ADD CONSTRAINT "FraudEnforcementAction_deviceFpId_fkey"
    FOREIGN KEY ("deviceFpId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL;
