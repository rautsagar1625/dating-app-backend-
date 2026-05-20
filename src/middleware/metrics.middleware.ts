import { Request, Response, NextFunction } from 'express';
import {
  httpRequestDuration,
  httpRequestTotal,
  httpErrorTotal,
  httpPayloadSize,
} from '../observability/metrics';

// Normalize dynamic route segments so metrics don't explode with one label per userId.
// Express attaches matched route to req.route.path after the handler runs — we read it
// in the response finish handler where it's already populated.
function normalizeRoute(req: Request): string {
  return req.route?.path ?? req.path.replace(/[0-9a-f-]{8,}/gi, ':id') ?? 'unknown';
}

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startHr = process.hrtime.bigint();

  if (req.headers['content-length']) {
    const bytes = parseInt(req.headers['content-length'], 10);
    if (!isNaN(bytes)) {
      httpPayloadSize.observe({ method: req.method, route: normalizeRoute(req) }, bytes);
    }
  }

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startHr) / 1e9;
    const route = normalizeRoute(req);
    const labels = { method: req.method, route, status_code: String(res.statusCode) };

    httpRequestDuration.observe(labels, durationMs);
    httpRequestTotal.inc(labels);

    if (res.statusCode >= 500) {
      httpErrorTotal.inc({ method: req.method, route });
    }
  });

  next();
};
