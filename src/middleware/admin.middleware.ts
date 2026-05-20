import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../services/prisma.service';

// ── Permission levels ──────────────────────────────────────────────────────────
//
// Roles (stored in User.role):
//   user        — regular app user
//   admin       — full admin access
//   moderator   — read + moderation actions only (no fraud tools, no flag edits)
//   analyst     — read-only analytics + dashboard (no mutations)
//
// The permission map below defines which roles have which permissions.

export type AdminPermission =
  | 'read:dashboard'
  | 'read:analytics'
  | 'read:users'
  | 'read:reports'
  | 'read:fraud'
  | 'read:flags'
  | 'read:queues'
  | 'write:users'      // ban / unban
  | 'write:reports'    // resolve reports
  | 'write:fraud'        // enforce / revoke
  | 'write:flags'        // create / update / delete flags
  | 'write:queues'       // pause / resume / retry jobs
  | 'write:media'        // quarantine / approve media
  | 'read:moderation'    // view moderation events, appeals, trust scores
  | 'write:moderation'   // resolve events, review appeals, manual enforce
  | 'write:monetization' // manage pricing experiments, refunds
  | 'read:revenue';      // view revenue analytics, cohort data

const ROLE_PERMISSIONS: Record<string, AdminPermission[]> = {
  admin: [
    'read:dashboard', 'read:analytics', 'read:users', 'read:reports',
    'read:fraud', 'read:flags', 'read:queues', 'read:moderation', 'read:revenue',
    'write:users', 'write:reports', 'write:fraud', 'write:flags', 'write:queues', 'write:media', 'write:moderation', 'write:monetization',
  ],
  moderator: [
    'read:dashboard', 'read:users', 'read:reports', 'read:fraud', 'read:moderation',
    'write:reports', 'write:users', 'write:media', 'write:moderation',
  ],
  analyst: [
    'read:dashboard', 'read:analytics', 'read:users', 'read:reports', 'read:fraud', 'read:flags', 'read:moderation', 'read:revenue',
  ],
};

// ── Core admin guard ───────────────────────────────────────────────────────────

export const requireAdmin = async (
  req: Request, res: Response, next: NextFunction,
): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { role: true },
    });

    if (!user || !['admin', 'moderator', 'analyst'].includes(user.role)) {
      res.status(403).json({ success: false, message: 'Forbidden: Admin only' });
      return;
    }

    // Attach role to request so requirePermission can read it without a second DB hit
    (req as any).adminRole = user.role;
    next();
  } catch {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── Fine-grained permission guard ─────────────────────────────────────────────

export function requirePermission(permission: AdminPermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const role = (req as any).adminRole as string | undefined;

    // If requireAdmin ran first, role is already attached; otherwise fetch it
    const effectiveRole = role ?? (
      await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { role: true },
      }).then((u) => u?.role ?? 'user').catch(() => 'user')
    );

    const allowed = ROLE_PERMISSIONS[effectiveRole] ?? [];
    if (!allowed.includes(permission)) {
      res.status(403).json({
        success: false,
        message: `Forbidden: requires ${permission}`,
      });
      return;
    }

    next();
  };
}

// ── Audit log helper ───────────────────────────────────────────────────────────
//
// Call this from any admin controller action that mutates data.
// Fire-and-forget — never throws.

export function auditLog(
  adminId: string,
  action: string,
  opts: {
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
    req?: Request;
  } = {},
): void {
  const ipRaw = opts.req?.ip ?? '';
  const ipHash = ipRaw ? crypto.createHash('sha256').update(ipRaw).digest('hex').slice(0, 16) : undefined;

  prisma.adminAuditLog
    .create({
      data: {
        adminId,
        action,
        targetType: opts.targetType,
        targetId: opts.targetId,
        metadata: (opts.metadata ?? {}) as object,
        ipHash,
        requestId: (opts.req as any)?.requestId,
      },
    })
    .catch(() => {});
}
