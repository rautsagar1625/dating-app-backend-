import prisma from './prisma.service';

// Expo Push API — no extra dependency needed, plain HTTPS POST
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushPayload {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
}

// Fire-and-forget — send push to every registered device for a user.
// Called from notification.service.ts; never throws.
export const sendPushToUser = async (
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> => {
  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });

    if (tokens.length === 0) return;

    const messages: PushPayload[] = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      sound: 'default',
      data: data ?? {},
    }));

    // Expo accepts batches of up to 100 messages
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch {
    // Push is non-critical — never propagate
  }
};
