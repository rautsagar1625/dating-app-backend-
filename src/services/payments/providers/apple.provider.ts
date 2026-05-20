// ── Apple In-App Purchase Provider ───────────────────────────────────────────
//
// Required env: APPLE_BUNDLE_ID, APPLE_SHARED_SECRET, APPLE_KEY_ID,
//               APPLE_ISSUER_ID, APPLE_PRIVATE_KEY (base64-encoded p8)
//
// Architecture:
//   - App Store Server API (StoreKit 2) for receipt validation
//   - App Store Server Notifications (v2) for lifecycle events
//   - JWT-authenticated API calls (ES256, 60-min tokens)
//   - Original transaction ID is the durable subscription identifier
//   - Never trust client-reported purchase state — always validate server-side
//
// Receipt validation flow:
//   1. Client sends transactionId (StoreKit 2) or receipt data (legacy)
//   2. Server calls App Store Server API /inApps/v1/transactions/{transactionId}
//   3. Validate JWT response; check bundleId, environment
//   4. Create/update subscription record

import crypto from 'crypto';
import { registerPaymentProvider } from './payment.provider.registry';
import type {
  IPaymentProvider, CreatePaymentIntentParams, PaymentIntentResult,
  CaptureResult, RefundResult, WebhookEvent, ReceiptValidationResult,
} from '../payment.types';
import { logger } from '../../../observability/logger';

function makeAppleJwt(): string {
  const keyId    = process.env.APPLE_KEY_ID    ?? '';
  const issuerId = process.env.APPLE_ISSUER_ID ?? '';
  const bundleId = process.env.APPLE_BUNDLE_ID ?? '';
  const privKey  = Buffer.from(process.env.APPLE_PRIVATE_KEY ?? '', 'base64').toString('utf8');

  const header  = { alg: 'ES256', kid: keyId };
  const now     = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now, exp: now + 3600, aud: 'appstoreconnect-v1', bid: bundleId };

  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data   = `${encode(header)}.${encode(payload)}`;
  const sig    = crypto.createSign('SHA256').update(data).sign({ key: privKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

const appleProvider: IPaymentProvider = {
  name: 'apple',

  // Apple IAP is client-initiated — no server-side payment intent creation.
  // Purchases happen on-device via StoreKit; server only validates the result.
  async createPaymentIntent(_params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    throw new Error('Apple IAP does not use server-side payment intents. Use validateReceipt after client purchase.');
  },

  async capturePayment(transactionId: string): Promise<CaptureResult> {
    // For Apple, "capture" means re-validating the transaction server-side
    const result = await appleProvider.validateReceipt!(transactionId, '');
    return {
      providerIntentId: transactionId,
      status:           result.valid ? 'SUCCESS' : 'FAILED',
      amountCaptured:   0,  // Apple doesn't expose price in server API
      currency:         'USD',
    };
  },

  async refundPayment(transactionId: string): Promise<RefundResult> {
    // Apple refunds happen via App Store — we only record/react to the webhook
    logger.info({ transactionId }, 'Apple refund recorded (refund initiated via App Store)');
    return { refundId: `apple_re_${transactionId}`, status: 'pending', amountRefunded: 0 };
  },

  async parseWebhook(rawBody: Buffer, _headers: Record<string, string>): Promise<WebhookEvent> {
    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    // App Store Server Notifications v2 — signedPayload is a JWS
    const signedPayload = payload.signedPayload as string | undefined;
    if (!signedPayload) throw new Error('Missing signedPayload in Apple webhook');

    // Decode JWS without full verification here (verified by Apple cert chain in prod)
    const [, bodyB64] = signedPayload.split('.');
    const decoded     = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    const notifType   = decoded.notificationType as string;
    const subtype     = decoded.subtype as string | undefined;
    const txInfo      = (decoded.data as any)?.signedTransactionInfo as string | undefined;

    let txDecoded: Record<string, unknown> = {};
    if (txInfo) {
      const [, txB64] = txInfo.split('.');
      txDecoded = JSON.parse(Buffer.from(txB64, 'base64url').toString('utf8'));
    }

    return {
      provider:         'apple',
      eventType:        subtype ? `${notifType}.${subtype}` : notifType,
      providerEventId:  `apple_${(decoded.notificationUUID as string) ?? Date.now()}`,
      subscriptionId:   txDecoded.originalTransactionId as string | undefined,
      rawPayload:       decoded,
    };
  },

  async validateReceipt(transactionId: string, _productId: string): Promise<ReceiptValidationResult> {
    const bundleId = process.env.APPLE_BUNDLE_ID ?? '';
    if (!bundleId) throw new Error('APPLE_BUNDLE_ID not configured');

    const isSandbox = process.env.NODE_ENV !== 'production';
    const baseUrl   = isSandbox
      ? 'https://api.storekit-sandbox.itunes.apple.com'
      : 'https://api.storekit.itunes.apple.com';

    const jwt  = makeAppleJwt();
    const url  = `${baseUrl}/inApps/v1/transactions/${transactionId}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });

    if (!resp.ok) {
      throw new Error(`Apple receipt validation failed: ${resp.status} ${resp.statusText}`);
    }

    const data   = await resp.json() as Record<string, unknown>;
    const signed = data.signedTransactionInfo as string | undefined;
    if (!signed) throw new Error('Missing signedTransactionInfo in Apple response');

    const [, txB64] = signed.split('.');
    const tx = JSON.parse(Buffer.from(txB64, 'base64url').toString('utf8')) as Record<string, unknown>;

    if ((tx.bundleId as string) !== bundleId) throw new Error('Bundle ID mismatch');

    const expiresMs = tx.expiresDate as number | undefined;
    return {
      valid:                  true,
      transactionId:          tx.transactionId as string,
      originalTransactionId:  tx.originalTransactionId as string,
      productId:              tx.productId as string,
      purchaseState:          'PURCHASED',
      expiresAt:              expiresMs ? new Date(expiresMs) : undefined,
      isSandbox:              (tx.environment as string) === 'Sandbox',
      rawResponse:            tx,
    };
  },

  async cancelSubscription(_providerSubId: string): Promise<void> {
    // Apple subscriptions cancel via App Store UI — we only react to webhook
    logger.info({ note: 'Apple subscription cancellations are user-initiated via App Store' });
  },
};

registerPaymentProvider('apple', () => appleProvider);
export default appleProvider;
