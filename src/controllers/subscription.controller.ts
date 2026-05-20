import { Request, Response, NextFunction } from 'express';
import {
  getActiveSubscription,
  cancelSubscriptionForUser,
  validateAndActivateMobileSubscription,
} from '../services/subscriptions/subscription.lifecycle';
import { getEntitlementBundle } from '../services/entitlements/entitlement.engine';
import { getSubscriberRetentionCohort, getPaywallConversionFunnel } from '../services/monetization/revenue.analytics';
import { detectChurnRisk } from '../services/monetization/whale.intelligence';
import { buildOffer } from '../services/monetization/offer.engine';
import prisma from '../services/prisma.service';

// GET /api/subscriptions/me
export const getMySubscription = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const [sub, entitlements] = await Promise.all([
      getActiveSubscription(userId),
      getEntitlementBundle(userId),
    ]);

    res.status(200).json({
      success: true,
      data: {
        subscription:  sub,
        entitlements:  entitlements.features,
        tier:          entitlements.tier ?? null,
        expiresAt:     entitlements.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/subscriptions/validate-receipt  (mobile IAP)
export const validateMobileReceipt = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { platform, receiptToken, productId } = req.body;

    if (!platform || !['apple', 'google'].includes(platform)) {
      res.status(400).json({ success: false, message: 'platform must be apple or google' });
      return;
    }
    if (!receiptToken || !productId) {
      res.status(400).json({ success: false, message: 'receiptToken and productId are required' });
      return;
    }

    const result = await validateAndActivateMobileSubscription({ userId, platform, receiptToken, productId });
    const entitlements = await getEntitlementBundle(userId);

    res.status(200).json({
      success: true,
      data: {
        subscriptionId: result.subscriptionId,
        entitlements:   entitlements.features,
        tier:           entitlements.tier,
      },
    });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// POST /api/subscriptions/cancel
export const cancelSubscription = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId      = req.user!.userId;
    const { immediately = false } = req.body;

    // Check churn risk and potentially surface a save offer
    const churnRisk = await detectChurnRisk(userId);
    if (churnRisk.atRisk) {
      const saveOffer = await buildOffer({ userId, offerType: 'CHURN_SAVE_OFFER', discount: 0.3 });
      if (saveOffer) {
        // Surface save offer before completing cancellation
        res.status(200).json({
          success:       true,
          requiresOffer: true,
          offer:         saveOffer,
          message:       'A special retention offer is available before cancelling.',
        });
        return;
      }
    }

    await cancelSubscriptionForUser(userId, immediately);
    res.status(200).json({ success: true, message: immediately ? 'Subscription cancelled immediately.' : 'Subscription will end at the current billing period.' });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// POST /api/subscriptions/cancel/confirm  — confirm cancel after seeing save offer
export const confirmCancellation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { immediately = false } = req.body;
    await cancelSubscriptionForUser(userId, immediately);
    res.status(200).json({ success: true });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// ── Admin endpoints ───────────────────────────────────────────────────────────

// GET /api/subscriptions/admin/stats
export const adminSubscriptionStats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [active, pastDue, cancelled, expired, byTier] = await Promise.all([
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
      prisma.subscription.count({ where: { status: 'CANCELLED' } }),
      prisma.subscription.count({ where: { status: 'EXPIRED' } }),
      prisma.subscription.groupBy({
        by: ['tier', 'status'],
        where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
        _count: { _all: true },
      }),
    ]);

    const funnel = await getPaywallConversionFunnel(30);

    res.status(200).json({
      success: true,
      data: {
        counts: { active, pastDue, cancelled, expired },
        byTier,
        conversionFunnel: funnel,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/subscriptions/admin/retention-cohort
export const adminRetentionCohort = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const cohortMonth = req.query.month
      ? new Date(req.query.month as string)
      : new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1);

    const data = await getSubscriberRetentionCohort({
      cohortMonth,
      intervals: [1, 3, 6, 12],
    });

    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
