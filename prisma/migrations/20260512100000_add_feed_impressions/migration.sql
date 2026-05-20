-- Feed impression tracking: remember which profiles each user has already seen
-- so the browse feed doesn't repeat them within a 24-hour window.
CREATE TABLE "FeedImpression" (
  "id"          TEXT         NOT NULL PRIMARY KEY,
  "viewerId"    TEXT         NOT NULL,
  "profileId"   TEXT         NOT NULL,
  "seenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique per viewer+profile (upsert-safe)
CREATE UNIQUE INDEX "FeedImpression_viewerId_profileId_key" ON "FeedImpression"("viewerId", "profileId");
-- Hot path: exclude already-seen profiles for a viewer
CREATE INDEX "FeedImpression_viewerId_seenAt_idx" ON "FeedImpression"("viewerId", "seenAt" DESC);
