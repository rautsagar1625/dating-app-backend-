-- Risk profile: one row per user, lazily created on first risk event
CREATE TABLE "UserRiskProfile" (
  "id"              TEXT         NOT NULL PRIMARY KEY,
  "userId"          TEXT         NOT NULL UNIQUE,
  "riskScore"       INTEGER      NOT NULL DEFAULT 0,
  "reportCount"     INTEGER      NOT NULL DEFAULT 0,
  "blockCount"      INTEGER      NOT NULL DEFAULT 0,
  "spamFlags"       INTEGER      NOT NULL DEFAULT 0,
  "isSoftBanned"    BOOLEAN      NOT NULL DEFAULT false,
  "softBanReason"   TEXT,
  "softBannedAt"    TIMESTAMP(3),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "UserRiskProfile_riskScore_idx" ON "UserRiskProfile"("riskScore" DESC);
