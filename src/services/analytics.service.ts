import prisma from './prisma.service';

// All event names in the system — extend as new features are added
export type AnalyticsEventName =
  | 'register'
  | 'login'
  | 'profile_view'
  | 'like_sent'
  | 'like_received'
  | 'chat_started'
  | 'chat_unlocked'
  | 'message_sent'
  | 'photo_access_requested'
  | 'photo_access_granted'
  | 'block_issued'
  | 'report_filed'
  | 'push_token_registered'
  | 'notification_opened';

/**
 * Fire-and-forget analytics write. Never throws — analytics must never
 * affect the critical path or crash the server.
 */
export const trackEvent = (
  event: AnalyticsEventName,
  userId: string | null,
  properties: Record<string, unknown> = {},
): void => {
  prisma.analyticsEvent
    .create({ data: { event, userId, properties: properties as object } })
    .catch(() => {});
};
