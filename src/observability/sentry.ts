import * as Sentry from '@sentry/node';

export const initSentry = (): void => {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
  });
};

export const captureException = (err: unknown, context?: Record<string, unknown>): void => {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(err);
  });
};

export const captureMessage = (
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: Record<string, unknown>,
): void => {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureMessage(message, level);
  });
};

export { Sentry };
