-- Analytics event log: append-only, never updated
CREATE TABLE "AnalyticsEvent" (
  "id"         TEXT        NOT NULL PRIMARY KEY,
  "userId"     TEXT,                             -- null for anonymous events
  "event"      TEXT        NOT NULL,             -- e.g. 'profile_view', 'like_sent'
  "properties" JSONB       NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Hot query: events by user chronologically
CREATE INDEX "AnalyticsEvent_userId_occurredAt_idx" ON "AnalyticsEvent"("userId", "occurredAt" DESC);
-- Hot query: funnel analysis by event type
CREATE INDEX "AnalyticsEvent_event_occurredAt_idx" ON "AnalyticsEvent"("event", "occurredAt" DESC);
