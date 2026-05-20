import { Request, Response, NextFunction } from 'express';
import { createPaymentSession, initiateRefund } from '../services/payments/payment.session';
import { getPaymentProvider } from '../services/payments/providers/payment.provider.registry';
import { paymentWebhookQueue } from '../services/payments/payment.queue';
import { recordProviderEvent } from '../services/payments/payment.session';
import { PRODUCT_CATALOG } from '../services/payments/payment.types';
import type { PaymentProvider } from '../services/payments/payment.types';
import prisma from '../services/prisma.service';
import { logger } from '../observability/logger';
import { captureException } from '../observability/sentry';

// POST /api/payments/intent
// Creates a payment intent / order. Client uses clientSecret or checkoutUrl to complete.
export const createIntent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { productId, provider, idempotencyKey, currency = 'USD', metadata } = req.body;

    if (!productId || !provider || !idempotencyKey) {
      res.status(400).json({ success: false, message: 'productId, provider, idempotencyKey are required' });
      return;
    }
    if (!PRODUCT_CATALOG[productId]) {
      res.status(400).json({ success: false, message: `Unknown product: ${productId}` });
      return;
    }

    const result = await createPaymentSession({
      userId,
      idempotencyKey,
      productId,
      provider:  provider as PaymentProvider,
      currency,
      metadata,
    });

    const sku = PRODUCT_CATALOG[productId];
    res.status(result.alreadyCompleted ? 200 : 201).json({
      success: true,
      data: {
        sessionId:        result.sessionId,
        clientSecret:     result.clientSecret,
        checkoutUrl:      result.checkoutUrl,
        alreadyCompleted: result.alreadyCompleted,
        amountUsd:        sku.amountUsd,
        currency,
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

// GET /api/payments/history
export const getPaymentHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const limit  = Math.min(parseInt(req.query.limit as string ?? '20'), 50);
    const cursor = req.query.cursor as string | undefined;

    const sessions = await prisma.paymentSession.findMany({
      where: {
        userId,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true, productType: true, productId: true,
        amountUsd: true, currency: true, status: true,
        createdAt: true, refundedAt: true,
      },
    });

    const hasMore = sessions.length > limit;
    const items   = hasMore ? sessions.slice(0, limit) : sessions;

    res.status(200).json({
      success: true,
      data: {
        sessions:   items,
        nextCursor: hasMore ? items[items.length - 1]?.createdAt.toISOString() : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/payments/:sessionId/refund   (admin only)
export const requestRefund = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const requestedBy = req.user!.userId;
    const sessionId   = req.params.sessionId as string;
    const { reason, amountUsd } = req.body;

    if (!reason) {
      res.status(400).json({ success: false, message: 'reason is required' });
      return;
    }

    const { refundId } = await initiateRefund({ sessionId, reason, amountUsd, requestedBy });
    res.status(200).json({ success: true, data: { refundId } });
  } catch (err: any) {
    if (err.statusCode) {
      res.status(err.statusCode).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
};

// GET /api/payments/products  — client fetches available products + prices
export const listProducts = async (_req: Request, res: Response): Promise<void> => {
  const products = Object.values(PRODUCT_CATALOG).map((sku) => ({
    id:         sku.id,
    type:       sku.type,
    tier:       sku.tier,
    interval:   sku.interval,
    amountUsd:  sku.amountUsd,
    currency:   sku.currency,
  }));
  res.status(200).json({ success: true, data: { products } });
};

// ── Webhook endpoints (raw body required — registered before json middleware) ──

// POST /api/payments/webhooks/stripe
export const stripeWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = getPaymentProvider('stripe');
    const event    = await provider.parseWebhook(req.body as Buffer, req.headers as Record<string, string>);
    const eventId  = await recordProviderEvent({
      provider:        'stripe',
      eventType:       event.eventType,
      providerEventId: event.providerEventId,
      rawPayload:      event.rawPayload,
    });
    await paymentWebhookQueue.add(event.eventType, { event, rawBody: (req.body as Buffer).toString() }, {
      jobId: `webhook:${event.providerEventId}`,
    });
    logger.info({ eventId, eventType: event.eventType }, 'stripe webhook queued');
    res.status(200).json({ received: true });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'stripe webhook rejected');
    res.status(err.statusCode === 400 ? 400 : 500).json({ error: err.message });
  }
};

// POST /api/payments/webhooks/razorpay
export const razorpayWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = getPaymentProvider('razorpay');
    const event    = await provider.parseWebhook(req.body as Buffer, req.headers as Record<string, string>);
    await paymentWebhookQueue.add(event.eventType, { event, rawBody: (req.body as Buffer).toString() }, {
      jobId: `webhook:${event.providerEventId}`,
    });
    res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    res.status(err.statusCode === 400 ? 400 : 500).json({ error: err.message });
  }
};

// POST /api/payments/webhooks/apple
export const appleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = getPaymentProvider('apple');
    const event    = await provider.parseWebhook(req.body as Buffer, req.headers as Record<string, string>);
    await paymentWebhookQueue.add(event.eventType, { event, rawBody: (req.body as Buffer).toString() }, {
      jobId: `webhook:${event.providerEventId}`,
    });
    res.status(200).send('OK');
  } catch (err: any) {
    captureException(err, { source: 'apple_webhook' });
    res.status(200).send('OK');  // Apple requires 200 even on error
  }
};

// POST /api/payments/webhooks/google  (Pub/Sub push)
export const googleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = getPaymentProvider('google');
    const event    = await provider.parseWebhook(req.body as Buffer, req.headers as Record<string, string>);
    await paymentWebhookQueue.add(event.eventType, { event, rawBody: (req.body as Buffer).toString() }, {
      jobId: `webhook:${event.providerEventId}`,
    });
    res.status(204).send();  // Pub/Sub expects 2xx to ack
  } catch (err: any) {
    captureException(err, { source: 'google_webhook' });
    res.status(204).send();  // Ack even on error to prevent Pub/Sub retry storm
  }
};
