import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: 'velvet-api' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,service',
        },
      })
    : pino.destination({ sync: false }),
);

export const requestLogger = (requestId: string, userId?: string) =>
  logger.child({ requestId, ...(userId ? { userId } : {}) });

export const socketLogger = (socketId: string, userId?: string) =>
  logger.child({ socketId, ...(userId ? { userId } : {}), transport: 'ws' });

export const queueLogger = (queue: string, jobId?: string) =>
  logger.child({ queue, ...(jobId ? { jobId } : {}), transport: 'queue' });
