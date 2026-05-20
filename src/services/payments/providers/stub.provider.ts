// ── Stub Payment Provider ─────────────────────────────────────────────────────
// Used in development / tests. Never errors; always succeeds instantly.

import { registerPaymentProvider } from './payment.provider.registry';
import type {
  IPaymentProvider, CreatePaymentIntentParams, PaymentIntentResult,
  CaptureResult, RefundResult, WebhookEvent, ReceiptValidationResult,
} from '../payment.types';

const stubProvider: IPaymentProvider = {
  name: 'stub',

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    const id = `stub_pi_${params.idempotencyKey}`;
    return {
      providerIntentId: id,
      clientSecret:     `${id}_secret`,
      status:           'created',
      rawResponse:      { stub: true },
    };
  },

  async capturePayment(providerIntentId: string): Promise<CaptureResult> {
    return {
      providerIntentId,
      status:         'SUCCESS',
      amountCaptured: 0,
      currency:       'USD',
      receiptData:    JSON.stringify({ stub: true, id: providerIntentId }),
    };
  },

  async refundPayment(providerIntentId: string, amountUsd?: number): Promise<RefundResult> {
    return {
      refundId:       `stub_re_${providerIntentId}`,
      status:         'succeeded',
      amountRefunded: amountUsd ?? 0,
    };
  },

  async parseWebhook(rawBody: Buffer, _headers: Record<string, string>): Promise<WebhookEvent> {
    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    return {
      provider:        'stub',
      eventType:       (payload.type as string) ?? 'stub.event',
      providerEventId: `stub_evt_${Date.now()}`,
      rawPayload:      payload,
    };
  },

  async validateReceipt(token: string, productId: string): Promise<ReceiptValidationResult> {
    return {
      valid:           true,
      transactionId:   `stub_tx_${token.slice(0, 8)}`,
      productId,
      purchaseState:   'PURCHASED',
      isSandbox:       true,
      rawResponse:     { stub: true },
    };
  },

  async cancelSubscription(_providerSubId: string): Promise<void> {},
};

registerPaymentProvider('stub', () => stubProvider);
export default stubProvider;
