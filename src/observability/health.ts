import { Request, Response } from 'express';
import prisma from '../services/prisma.service';
import { redisConnection, notificationWorker } from '../services/notification.queue';

export const healthCheck = async (_req: Request, res: Response): Promise<void> => {
  const checks = await runChecks();
  const allHealthy = Object.values(checks).every((c) => c.status === 'ok');
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  });
};

export const readinessCheck = async (_req: Request, res: Response): Promise<void> => {
  const checks = await runChecks();
  const ready = checks.postgres.status === 'ok' && checks.redis.status === 'ok';
  res.status(ready ? 200 : 503).json({ ready, timestamp: new Date().toISOString(), checks });
};

export const livenessCheck = (_req: Request, res: Response): void => {
  res.status(200).json({ alive: true, uptime: process.uptime() });
};

async function runChecks() {
  const [postgres, redis, queue] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkQueue(),
  ]);
  return { postgres, redis, queue, memory: checkMemory() };
}

async function checkPostgres() {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' as const, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'error' as const, message: err.message };
  }
}

async function checkRedis() {
  const start = Date.now();
  try {
    await redisConnection.ping();
    return { status: 'ok' as const, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'error' as const, message: err.message };
  }
}

async function checkQueue() {
  try {
    const isPaused = await notificationWorker.isPaused();
    const isRunning = notificationWorker.isRunning();
    return {
      status: isRunning && !isPaused ? ('ok' as const) : ('degraded' as const),
      running: isRunning,
      paused: isPaused,
    };
  } catch (err: any) {
    return { status: 'error' as const, message: err.message };
  }
}

function checkMemory() {
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  const heapPct = Math.round((heapUsed / heapTotal) * 100);
  return {
    status: heapPct < 85 ? ('ok' as const) : ('warning' as const),
    heapUsedMb: Math.round(heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(heapTotal / 1024 / 1024),
    rssMb: Math.round(rss / 1024 / 1024),
    heapPct,
  };
}
