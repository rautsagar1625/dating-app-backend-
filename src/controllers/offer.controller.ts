import { Request, Response, NextFunction } from 'express';
import {
  buildOffer,
  recordOfferConversion,
  evaluateOfferTrigger,
  checkAbandonmentRecovery,
} from '../services/monetization/offer.engine';
import {
  getUserSegment,
  getVipTreatment,
  detectChurnRisk,
} from '../services/monetization/whale.intelligence';
import {
  createMonetizationExperiment,
  activateMonetizationExperiment,
  stopMonetizationExperiment,
  getExperimentResults,
} from '../services/monetization/monetization.experiment';
import { getPaywallConversionFunnel } from '../services/monetization/revenue.analytics';
import prisma from '../services/prisma.service';

// POST /api/offers/trigger
// Called by client at trigger points (chat locked, likes wall, etc.)
export const triggerOffer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId  = req.user!.userId;
    const { trigger, context } = req.body;

    if (!trigger) {
      res.status(400).json({ success: false, message: 'trigger is required' });
      return;
    }

    // Check for abandonment recovery first
    const abandoned = await checkAbandonmentRecovery(userId);
    if (abandoned) {
      const offer = await buildOffer({ userId, offerType: 'ABANDONMENT_RECOVERY', context: trigger });
      if (offer) {
        res.status(200).json({ success: true, data: { offer, sessionId: abandoned.sessionId } });
        return;
      }
    }

    const offer = await evaluateOfferTrigger({ userId, trigger, context });
    res.status(200).json({ success: true, data: { offer } });
  } catch (err) {
    next(err);
  }
};

// POST /api/offers/:exposureId/convert
export const convertOffer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const exposureId = req.params.exposureId as string;
    const { revenue } = req.body;
    await recordOfferConversion({ exposureId, revenue });
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// POST /api/offers/:exposureId/dismiss
export const dismissOffer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const exposureId = req.params.exposureId as string;
    await prisma.offerExposure.update({
      where: { id: exposureId },
      data:  { dismissedAt: new Date() },
    }).catch(() => {});
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// GET /api/offers/segment  — returns user's monetization segment + VIP treatment
export const getMySegment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId  = req.user!.userId;
    const segment = await getUserSegment(userId);
    const vip     = getVipTreatment(segment.segment);
    const churn   = await detectChurnRisk(userId);

    res.status(200).json({
      success: true,
      data: {
        segment:       segment.segment,
        ltv:           segment.ltv,
        fatigueScore:  segment.fatigueScore,
        vipTreatment:  vip,
        churnRisk:     churn,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Admin — experiment management ─────────────────────────────────────────────

// POST /api/offers/admin/experiments
export const adminCreateExperiment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, type, description, trafficPct = 100, variants } = req.body;
    if (!name || !type || !variants?.length) {
      res.status(400).json({ success: false, message: 'name, type, and variants are required' });
      return;
    }
    const id = await createMonetizationExperiment({ name, type, description, trafficPct, variants });
    res.status(201).json({ success: true, data: { experimentId: id } });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/offers/admin/experiments/:experimentId/activate
export const adminActivateExperiment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await activateMonetizationExperiment(req.params.experimentId as string);
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/offers/admin/experiments/:experimentId/stop
export const adminStopExperiment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await stopMonetizationExperiment(req.params.experimentId as string);
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// GET /api/offers/admin/experiments/:experimentId/results
export const adminExperimentResults = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const results = await getExperimentResults(req.params.experimentId as string);
    res.status(200).json({ success: true, data: { results } });
  } catch (err) {
    next(err);
  }
};

// GET /api/offers/admin/funnel
export const adminOfferFunnel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const days = parseInt(req.query.days as string ?? '30', 10);
    const data = await getPaywallConversionFunnel(days);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
