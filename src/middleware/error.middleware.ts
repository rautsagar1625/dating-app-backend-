import { Request, Response, NextFunction } from 'express';
import { requestLogger } from '../observability/logger';
import { captureException } from '../observability/sentry';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction): void => {
  const statusCode: number = err.statusCode ?? 500;
  const log = requestLogger(req.requestId ?? 'unknown', req.user?.userId);

  if (statusCode >= 500) {
    log.error(
      { method: req.method, url: req.url, statusCode, err: { message: err.message, stack: err.stack } },
      'unhandled server error',
    );
    captureException(err, {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      userId: req.user?.userId,
    });
  } else {
    log.warn({ method: req.method, url: req.url, statusCode, message: err.message }, 'client error');
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode < 500 ? err.message : 'Internal Server Error',
    requestId: req.requestId,
  });
};
