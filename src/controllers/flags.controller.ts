import { Request, Response, NextFunction } from 'express';
import {
  createFlag,
  updateFlag,
  deleteFlag,
  setOverride,
  removeOverride,
  listFlags,
  getFlagAuditLog,
  evaluateAll,
} from '../services/flags/flag.service';
import type { Platform } from '../services/flags/flag.types';

// ── Public (authenticated) ────────────────────────────────────────────────────

// GET /api/flags/evaluate
// Returns the full flag map for the current user — call once at login and cache.
// Platform and region are read from headers so the server never has to trust client claims.
export const evaluate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const platform = (req.headers['x-platform'] as Platform | undefined) ?? undefined;
    const region = (req.headers['x-region'] as string | undefined) ?? undefined;

    const flags = await evaluateAll({ userId, platform, region });
    res.status(200).json({ success: true, data: flags });
  } catch (error) {
    next(error);
  }
};

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/admin/flags
export const getFlags = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const flags = await listFlags();
    res.status(200).json({ success: true, data: flags });
  } catch (error) {
    next(error);
  }
};

// POST /api/admin/flags
export const createFlagHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { key, description, enabled, rolloutPercentage, targetUserIds, blockedUserIds, platforms, regions, metadata, expiresAt } = req.body;

    if (!key || typeof key !== 'string') {
      res.status(400).json({ success: false, message: '`key` is required' });
      return;
    }
    if (rolloutPercentage !== undefined && (rolloutPercentage < 0 || rolloutPercentage > 100)) {
      res.status(400).json({ success: false, message: 'rolloutPercentage must be 0-100' });
      return;
    }

    const flag = await createFlag(
      {
        key,
        description,
        enabled,
        rolloutPercentage,
        targetUserIds,
        blockedUserIds,
        platforms,
        regions,
        metadata,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
      req.user!.userId,
    );

    res.status(201).json({ success: true, data: flag });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ success: false, message: 'Flag key already exists' });
      return;
    }
    next(error);
  }
};

// PATCH /api/admin/flags/:key
export const updateFlagHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const key = req.params.key as string;
    const { description, enabled, rolloutPercentage, targetUserIds, blockedUserIds, platforms, regions, metadata, expiresAt } = req.body;

    if (rolloutPercentage !== undefined && (rolloutPercentage < 0 || rolloutPercentage > 100)) {
      res.status(400).json({ success: false, message: 'rolloutPercentage must be 0-100' });
      return;
    }

    const flag = await updateFlag(
      key,
      {
        ...(description !== undefined ? { description } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(rolloutPercentage !== undefined ? { rolloutPercentage } : {}),
        ...(targetUserIds !== undefined ? { targetUserIds } : {}),
        ...(blockedUserIds !== undefined ? { blockedUserIds } : {}),
        ...(platforms !== undefined ? { platforms } : {}),
        ...(regions !== undefined ? { regions } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
      },
      req.user!.userId,
    );

    res.status(200).json({ success: true, data: flag });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/flags/:key
export const deleteFlagHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await deleteFlag(req.params.key as string, req.user!.userId);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/flags/:key/audit
export const getAuditLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? '50', 10));
    const logs = await getFlagAuditLog(req.params.key as string, limit);
    res.status(200).json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
};

// PUT /api/admin/flags/:key/overrides/:userId
export const setOverrideHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const key = req.params.key as string;
    const userId = req.params.userId as string;
    const { enabled, reason = '' } = req.body;

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, message: '`enabled` must be a boolean' });
      return;
    }

    await setOverride(key, userId, enabled, reason, req.user!.userId);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/admin/flags/:key/overrides/:userId
export const removeOverrideHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await removeOverride(req.params.key as string, req.params.userId as string, req.user!.userId);
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};
