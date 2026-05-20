// ── Google Play Billing Provider ──────────────────────────────────────────────
//
// Required env: GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_SERVICE_ACCOUNT_JSON (base64)
// Optional dep: googleapis — install with: npm i googleapis
//
// Architecture:
//   - Google Play Developer API for purchase/subscription validation
//   - Real-time Developer Notifications (RTDN) via Pub/Sub for lifecycle events
//   - JWT service account auth (auto-refreshed by googleapis)
//   - purchaseToken is the durable subscription identifier
//   - Never trust client purchase state — always validate via server API
//
// Validation flow:
//   1. Client sends purchaseToken + productId
//   2. Server calls purchases.subscriptions.get or purchases.products.get
//   3. Verify packageName, acknowledgementState, paymentState
//   4. Acknowledge purchase to prevent auto-refund (within 3 days)

import { registerPaymentProvider } from './payment.provider.registry';
import type {
  IPaymentProvider, CreatePaymentIntentParams, PaymentIntentResult,
  CaptureResult, RefundResult, WebhookEvent, ReceiptValidationResult,
} from '../payment.types';
import { logger } from '../../../observability/logger';

const googleProvider: IPaymentProvider = {
  name: 'google',

  async createPaymentIntent(_params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    throw new Error('Google Play Billing is client-initiated. Use validateReceipt after client purchase.');
  },

  async capturePayment(purchaseToken: string): Promise<CaptureResult> {
    const result = await googleProvider.validateReceipt!(purchaseToken, '');
    return {
      providerIntentId: purchaseToken,
      status:           result.valid ? 'SUCCESS' : 'FAILED',
      amountCaptured:   0,
      currency:         'USD',
    };
  },

  async refundPayment(_purchaseToken: string): Promise<RefundResult> {
    // Google refunds are initiated via Play Console or automatically on chargeback
    logger.info('Google Play refund recorded (initiated via Play Console)');
    return { refundId: `gp_re_${Date.now()}`, status: 'pending', amountRefunded: 0 };
  },

  async parseWebhook(rawBody: Buffer, _headers: Record<string, string>): Promise<WebhookEvent> {
    // Google RTDN comes as a Pub/Sub push message
    const envelope = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    const message  = envelope.message as Record<string, unknown> | undefined;
    if (!message?.data) throw new Error('Invalid Google RTDN envelope');

    const data    = JSON.parse(Buffer.from(message.data as string, 'base64').toString('utf8')) as Record<string, unknown>;
    const subNotif = data.subscriptionNotification as Record<string, unknown> | undefined;
    const notifType = subNotif?.notificationType;

    const notifTypeMap: Record<number, string> = {
      1: 'SUBSCRIPTION_RECOVERED', 2: 'SUBSCRIPTION_RENEWED', 3: 'SUBSCRIPTION_CANCELED',
      4: 'SUBSCRIPTION_PURCHASED', 5: 'SUBSCRIPTION_ON_HOLD', 6: 'SUBSCRIPTION_IN_GRACE_PERIOD',
      7: 'SUBSCRIPTION_RESTARTED', 8: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED',
      12: 'SUBSCRIPTION_DEFERRED', 13: 'SUBSCRIPTION_PAUSED', 20: 'SUBSCRIPTION_EXPIRED',
    };

    return {
      provider:         'google',
      eventType:        notifTypeMap[notifType as number] ?? `GOOGLE_NOTIF_${notifType}`,
      providerEventId:  `gp_${(message.messageId as string) ?? Date.now()}`,
      subscriptionId:   subNotif?.purchaseToken as string | undefined,
      rawPayload:       data,
    };
  },

  async validateReceipt(purchaseToken: string, productId: string): Promise<ReceiptValidationResult> {
    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
    const saJson      = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!packageName || !saJson) throw new Error('GOOGLE_PLAY_* env vars not set');

    // @ts-expect-error optional peer dependency
    const { google } = await import('googleapis');
    const serviceAccount = JSON.parse(Buffer.from(saJson, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const androidPublisher = google.androidpublisher({ version: 'v3', auth });

    // Try subscription first, fall back to one-time product
    try {
      const sub = await androidPublisher.purchases.subscriptions.get({
        packageName,
        subscriptionId: productId,
        token:          purchaseToken,
      });
      const d = sub.data;
      const expiryMs = parseInt(d.expiryTimeMillis ?? '0', 10);

      // Acknowledge if not yet acknowledged (required within 3 days)
      if (d.acknowledgementState === 0) {
        await androidPublisher.purchases.subscriptions.acknowledge({
          packageName,
          subscriptionId: productId,
          token:          purchaseToken,
          requestBody:    {},
        }).catch(() => {});
      }

      return {
        valid:          d.paymentState === 1,
        transactionId:  purchaseToken,
        productId,
        purchaseState:  d.paymentState === 1 ? 'PURCHASED' : 'PENDING',
        expiresAt:      expiryMs ? new Date(expiryMs) : undefined,
        isSandbox:      d.purchaseType === 0,
        rawResponse:    d,
      };
    } catch {
      // Try consumable / one-time product
      const product = await androidPublisher.purchases.products.get({
        packageName,
        productId,
        token: purchaseToken,
      });
      const d = product.data;

      if (d.acknowledgementState === 0) {
        await androidPublisher.purchases.products.acknowledge({
          packageName, productId, token: purchaseToken, requestBody: {},
        }).catch(() => {});
      }

      return {
        valid:          d.purchaseState === 0,
        transactionId:  purchaseToken,
        productId,
        purchaseState:  d.purchaseState === 0 ? 'PURCHASED' : 'CANCELLED',
        isSandbox:      d.purchaseType === 0,
        rawResponse:    d,
      };
    }
  },

  async cancelSubscription(purchaseToken: string): Promise<void> {
    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
    const saJson      = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!packageName || !saJson) throw new Error('GOOGLE_PLAY_* env vars not set');

    // @ts-expect-error optional peer dependency
    const { google } = await import('googleapis');
    const serviceAccount = JSON.parse(Buffer.from(saJson, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const androidPublisher = google.androidpublisher({ version: 'v3', auth });
    await androidPublisher.purchases.subscriptions.cancel({
      packageName,
      subscriptionId: '',  // looked up from DB by purchaseToken in caller
      token: purchaseToken,
    });
    logger.info({ purchaseToken }, 'Google Play subscription cancelled');
  },
};

registerPaymentProvider('google', () => googleProvider);
export default googleProvider;
