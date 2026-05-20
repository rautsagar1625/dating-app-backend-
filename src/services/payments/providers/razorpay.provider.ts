// ── Razorpay Payment Provider ─────────────────────────────────────────────────
//
// Required env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
// Optional dep: razorpay — install with: npm i razorpay
//
// Architecture:
//   - Orders API for one-time purchases
//   - Subscriptions API for recurring billing (INR plans)
//   - Webhook signature: X-Razorpay-Signature (HMAC-SHA256)
//   - Payment verification: order_id + payment_id + signature

import crypto from 'crypto';
import { registerPaymentProvider } from './payment.provider.registry';
import type {
  IPaymentProvider, CreatePaymentIntentParams, PaymentIntentResult,
  CaptureResult, RefundResult, WebhookEvent,
} from '../payment.types';
import { logger } from '../../../observability/logger';

const razorpayProvider: IPaymentProvider = {
  name: 'razorpay',

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    const keyId  = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error('RAZORPAY_* env vars not set');

    // @ts-expect-error optional peer dependency
    const Razorpay = (await import('razorpay')).default;
    const rz = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const amountPaise = Math.round(params.amountUsd * 100);  // USD cents → paise (1:1 for now; use FX service in prod)
    const order = await rz.orders.create({
      amount:   amountPaise,
      currency: params.currency,
      receipt:  params.idempotencyKey.slice(0, 40),
      notes: {
        userId:    params.userId,
        productId: params.productId,
      },
    });

    return {
      providerIntentId: order.id,
      status:           order.status,
      rawResponse:      order,
    };
  },

  async capturePayment(orderId: string, signature?: string, payload?: string): Promise<CaptureResult> {
    // payload format: "razorpay_order_id|razorpay_payment_id"
    if (signature && payload) {
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keySecret) throw new Error('RAZORPAY_KEY_SECRET not set');

      const expected = crypto.createHmac('sha256', keySecret).update(payload).digest('hex');
      if (expected !== signature) {
        throw Object.assign(new Error('Invalid Razorpay payment signature'), { statusCode: 400 });
      }
    }

    const keyId  = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error('RAZORPAY_* env vars not set');

    // @ts-expect-error optional peer dependency
    const Razorpay = (await import('razorpay')).default;
    const rz = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const order = await rz.orders.fetch(orderId);
    const succeeded = order.status === 'paid';

    return {
      providerIntentId: orderId,
      status:           succeeded ? 'SUCCESS' : 'FAILED',
      amountCaptured:   (order.amount_paid ?? 0) / 100,
      currency:         order.currency,
      receiptData:      JSON.stringify({ orderId, status: order.status }),
    };
  },

  async refundPayment(paymentId: string, amountUsd?: number): Promise<RefundResult> {
    const keyId  = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error('RAZORPAY_* env vars not set');

    // @ts-expect-error optional peer dependency
    const Razorpay = (await import('razorpay')).default;
    const rz = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const params: Record<string, unknown> = { speed: 'normal' };
    if (amountUsd) params.amount = Math.round(amountUsd * 100);

    const refund = await rz.payments.refund(paymentId, params);
    return {
      refundId:       refund.id,
      status:         'pending',
      amountRefunded: (refund.amount ?? 0) / 100,
    };
  },

  async parseWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookEvent> {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) throw new Error('RAZORPAY_WEBHOOK_SECRET not set');

    const sig      = headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected !== sig) {
      throw Object.assign(new Error('Invalid Razorpay webhook signature'), { statusCode: 400 });
    }

    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    const entity  = (payload.payload as any)?.payment?.entity ?? {};

    return {
      provider:         'razorpay',
      eventType:        payload.event as string,
      providerEventId:  `rz_${(payload.created_at as number) ?? Date.now()}`,
      paymentIntentId:  entity.order_id as string | undefined,
      rawPayload:       payload,
    };
  },

  async cancelSubscription(providerSubId: string): Promise<void> {
    const keyId  = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error('RAZORPAY_* env vars not set');

    // @ts-expect-error optional peer dependency
    const Razorpay = (await import('razorpay')).default;
    const rz = new Razorpay({ key_id: keyId, key_secret: keySecret });
    await rz.subscriptions.cancel(providerSubId);
    logger.info({ providerSubId }, 'Razorpay subscription cancelled');
  },
};

registerPaymentProvider('razorpay', () => razorpayProvider);
export default razorpayProvider;
