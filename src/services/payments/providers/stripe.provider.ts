// ── Stripe Payment Provider ───────────────────────────────────────────────────
//
// Required env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Optional dep: stripe — install with: npm i stripe
//
// Architecture:
//   - PaymentIntents for one-time purchases (boosts, credit packs)
//   - Stripe Subscriptions for recurring billing
//   - Idempotency keys forwarded to Stripe for safe retries
//   - Webhook signature verified via Stripe-Signature header
//   - No card data ever touches our server (PCI scope reduction)

import { registerPaymentProvider } from './payment.provider.registry';
import type {
  IPaymentProvider, CreatePaymentIntentParams, PaymentIntentResult,
  CaptureResult, RefundResult, WebhookEvent, ReceiptValidationResult,
} from '../payment.types';
import { logger } from '../../../observability/logger';

const stripeProvider: IPaymentProvider = {
  name: 'stripe',

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');

    // @ts-expect-error optional peer dependency
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

    const amountCents = Math.round(params.amountUsd * 100);
    const intent = await stripe.paymentIntents.create({
      amount:   amountCents,
      currency: params.currency.toLowerCase(),
      metadata: {
        userId:     params.userId,
        productId:  params.productId,
        ...params.metadata,
      },
    }, { idempotencyKey: params.idempotencyKey });

    return {
      providerIntentId: intent.id,
      clientSecret:     intent.client_secret ?? undefined,
      status:           intent.status,
      rawResponse:      intent as unknown as Record<string, unknown>,
    };
  },

  async capturePayment(providerIntentId: string): Promise<CaptureResult> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');

    // @ts-expect-error optional peer dependency
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

    const intent = await stripe.paymentIntents.retrieve(providerIntentId);
    const succeeded = intent.status === 'succeeded';

    return {
      providerIntentId,
      status:         succeeded ? 'SUCCESS' : 'FAILED',
      amountCaptured: (intent.amount_received ?? 0) / 100,
      currency:       intent.currency.toUpperCase(),
      receiptData:    JSON.stringify({ id: intent.id, status: intent.status }),
    };
  },

  async refundPayment(providerIntentId: string, amountUsd?: number): Promise<RefundResult> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');

    // @ts-expect-error optional peer dependency
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

    const params: Record<string, unknown> = { payment_intent: providerIntentId };
    if (amountUsd) params.amount = Math.round(amountUsd * 100);

    const refund = await stripe.refunds.create(params as any);
    return {
      refundId:       refund.id,
      status:         refund.status === 'succeeded' ? 'succeeded' : 'pending',
      amountRefunded: (refund.amount ?? 0) / 100,
    };
  },

  async parseWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookEvent> {
    const key    = process.env.STRIPE_SECRET_KEY;
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!key || !secret) throw new Error('Stripe webhook env vars not set');

    // @ts-expect-error optional peer dependency
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

    const sig = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    const event = stripe.webhooks.constructEvent(rawBody, sig, secret);

    const obj = event.data.object as Record<string, unknown>;
    return {
      provider:         'stripe',
      eventType:        event.type,
      providerEventId:  event.id,
      paymentIntentId:  (obj.id as string) ?? undefined,
      subscriptionId:   (obj.subscription as string) ?? undefined,
      rawPayload:       event as unknown as Record<string, unknown>,
    };
  },

  async cancelSubscription(providerSubId: string, immediately = false): Promise<void> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');

    // @ts-expect-error optional peer dependency
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

    if (immediately) {
      await stripe.subscriptions.cancel(providerSubId);
    } else {
      await stripe.subscriptions.update(providerSubId, { cancel_at_period_end: true });
    }
    logger.info({ providerSubId, immediately }, 'Stripe subscription cancelled');
  },
};

registerPaymentProvider('stripe', () => stripeProvider);
export default stripeProvider;
