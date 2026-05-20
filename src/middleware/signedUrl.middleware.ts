import { Request, Response, NextFunction } from 'express';
import { verifySignedUrl } from '../services/signedUrl.service';

/**
 * Validates signed URL params (?sig=&exp=) for protected static files.
 * Attach this middleware before express.static for the /uploads route.
 * Public photos (no sig param) pass through; signed requests are verified.
 */
export const validateSignedUrl = (req: Request, res: Response, next: NextFunction): void => {
  const { sig, exp } = req.query as Record<string, string>;

  // If no signature present, let it through — public photos have no sig
  if (!sig) {
    next();
    return;
  }

  const urlPath = req.path; // e.g. /abc123.jpg
  if (!verifySignedUrl(urlPath, sig, exp)) {
    res.status(403).json({ success: false, message: 'Link expired or invalid' });
    return;
  }

  next();
};
