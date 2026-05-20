-- CreateTable: FeatureFlag
CREATE TABLE "FeatureFlag" (
    "id"                TEXT          NOT NULL,
    "key"               TEXT          NOT NULL,
    "description"       TEXT          NOT NULL DEFAULT '',
    "enabled"           BOOLEAN       NOT NULL DEFAULT false,
    "rolloutPercentage" INTEGER       NOT NULL DEFAULT 0,
    "targetUserIds"     TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
    "blockedUserIds"    TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
    "platforms"         TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
    "regions"           TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metadata"          JSONB         NOT NULL DEFAULT '{}',
    "expiresAt"         TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FeatureFlagOverride
CREATE TABLE "FeatureFlagOverride" (
    "id"        TEXT         NOT NULL,
    "flagId"    TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "enabled"   BOOLEAN      NOT NULL,
    "reason"    TEXT         NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureFlagOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FeatureFlagAuditLog
CREATE TABLE "FeatureFlagAuditLog" (
    "id"        TEXT         NOT NULL,
    "flagId"    TEXT         NOT NULL,
    "actorId"   TEXT,
    "action"    TEXT         NOT NULL,
    "before"    JSONB,
    "after"     JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureFlagAuditLog_pkey" PRIMARY KEY ("id")
);

-- Unique indexes
CREATE UNIQUE INDEX "FeatureFlag_key_key"                  ON "FeatureFlag"("key");
CREATE UNIQUE INDEX "FeatureFlagOverride_flagId_userId_key" ON "FeatureFlagOverride"("flagId", "userId");

-- Regular indexes
CREATE INDEX "FeatureFlag_key_idx"                ON "FeatureFlag"("key");
CREATE INDEX "FeatureFlagOverride_userId_idx"      ON "FeatureFlagOverride"("userId");
CREATE INDEX "FeatureFlagAuditLog_flagId_crAt_idx" ON "FeatureFlagAuditLog"("flagId", "createdAt" DESC);

-- Foreign keys
ALTER TABLE "FeatureFlagOverride"
    ADD CONSTRAINT "FeatureFlagOverride_flagId_fkey"
    FOREIGN KEY ("flagId") REFERENCES "FeatureFlag"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeatureFlagAuditLog"
    ADD CONSTRAINT "FeatureFlagAuditLog_flagId_fkey"
    FOREIGN KEY ("flagId") REFERENCES "FeatureFlag"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
