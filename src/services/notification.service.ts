import { enqueueNotification } from './notification.queue';

export type NotificationType = 'LIKE' | 'MESSAGE' | 'VISIT';

/**
 * Fire-and-forget: enqueues a notification job with built-in deduplication,
 * retry logic, and 2s debounce. Callers must NOT await.
 */
export const createNotification = (
  userId: string,
  type: NotificationType,
  referenceId: string,
): void => {
  enqueueNotification(userId, type, referenceId).catch(() => {});
};
