import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  req.requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};
