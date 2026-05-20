// ── Payment System Types ──────────────────────────────────────────────────────
//
// Shared types across all payment providers and the payment session layer.
// Provider-specific types live in each provider file.

// ── Core primitives ───────────────────────────────────────────────────────────

export type PaymentProvider = 'stripe' | 'razorpay' | 'apple' | 'google' | 'stub';
export type ProductType     = 'SUBSCRIPTION' | 'BOOST' | 'SUPERLIKE' | 'UNLOCK' | 'CREDIT_PACK';
export type PaymentStatus   = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'REFUNDED' | 'DISPUTED';
export type SubscriptionTier = 'VELVET_GOLD' | 'VELVET_PLATINUM' | 'VELVET_DIAMOND';
export type BillingInterval  = 'MONTH' | 'YEAR';

// ── Product catalog ───────────────────────────────────────────────────────────

export interface ProductSku {
  id:            string;           // canonical SKU (e.g. "gold_monthly_usd")
  type:          ProductType;
  tier?:         SubscriptionTier;
  interval?:     BillingInterval;
  amountUsd:     number;
  currency:      string;
  appleProductId?: string;
  googleProductId?: string;
  stripeProductId?: string;
  razorpayPlanId?: string;
}

// Centralized SKU catalog — single source of truth for all products
export const PRODUCT_CATALOG: Record<string, ProductSku> = {
  gold_monthly_usd: {
    id: 'gold_monthly_usd', type: 'SUBSCRIPTION', tier: 'VELVET_GOLD',
    interval: 'MONTH', amountUsd: 9.99, currency: 'USD',
    appleProductId: 'com.velvet.gold.monthly', googleProductId: 'velvet_gold_monthly',
    stripeProductId: 'prod_gold_monthly', razorpayPlanId: 'plan_gold_monthly_inr',
  },
  gold_yearly_usd: {
    id: 'gold_yearly_usd', type: 'SUBSCRIPTION', tier: 'VELVET_GOLD',
    interval: 'YEAR', amountUsd: 79.99, currency: 'USD',
    appleProductId: 'com.velvet.gold.yearly', googleProductId: 'velvet_gold_yearly',
    stripeProductId: 'prod_gold_yearly', razorpayPlanId: 'plan_gold_yearly_inr',
  },
  platinum_monthly_usd: {
    id: 'platinum_monthly_usd', type: 'SUBSCRIPTION', tier: 'VELVET_PLATINUM',
    interval: 'MONTH', amountUsd: 19.99, currency: 'USD',
    appleProductId: 'com.velvet.platinum.monthly', googleProductId: 'velvet_platinum_monthly',
    stripeProductId: 'prod_platinum_monthly', razorpayPlanId: 'plan_platinum_monthly_inr',
  },
  platinum_yearly_usd: {
    id: 'platinum_yearly_usd', type: 'SUBSCRIPTION', tier: 'VELVET_PLATINUM',
    interval: 'YEAR', amountUsd: 159.99, currency: 'USD',
    appleProductId: 'com.velvet.platinum.yearly', googleProductId: 'velvet_platinum_yearly',
    stripeProductId: 'prod_platinum_yearly', razorpayPlanId: 'plan_platinum_yearly_inr',
  },
  diamond_monthly_usd: {
    id: 'diamond_monthly_usd', type: 'SUBSCRIPTION', tier: 'VELVET_DIAMOND',
    interval: 'MONTH', amountUsd: 34.99, currency: 'USD',
    appleProductId: 'com.velvet.diamond.monthly', googleProductId: 'velvet_diamond_monthly',
    stripeProductId: 'prod_diamond_monthly', razorpayPlanId: 'plan_diamond_monthly_inr',
  },
  boost_30min: {
    id: 'boost_30min', type: 'BOOST', amountUsd: 2.99, currency: 'USD',
    appleProductId: 'com.velvet.boost.30min', googleProductId: 'velvet_boost_30min',
    stripeProductId: 'prod_boost_30min',
  },
  spotlight_24h: {
    id: 'spotlight_24h', type: 'BOOST', amountUsd: 4.99, currency: 'USD',
    appleProductId: 'com.velvet.spotlight.24h', googleProductId: 'velvet_spotlight_24h',
    stripeProductId: 'prod_spotlight_24h',
  },
  superlike_5pack: {
    id: 'superlike_5pack', type: 'SUPERLIKE', amountUsd: 1.99, currency: 'USD',
    appleProductId: 'com.velvet.superlike.5pack', googleProductId: 'velvet_superlike_5pack',
    stripeProductId: 'prod_superlike_5',
  },
  credits_100: {
    id: 'credits_100', type: 'CREDIT_PACK', amountUsd: 0.99, currency: 'USD',
    appleProductId: 'com.velvet.credits.100', googleProductId: 'velvet_credits_100',
    stripeProductId: 'prod_credits_100',
  },
  credits_500: {
    id: 'credits_500', type: 'CREDIT_PACK', amountUsd: 3.99, currency: 'USD',
    appleProductId: 'com.velvet.credits.500', googleProductId: 'velvet_credits_500',
    stripeProductId: 'prod_credits_500',
  },
};

// ── Provider interface ────────────────────────────────────────────────────────

export interface CreatePaymentIntentParams {
  userId:          string;
  idempotencyKey:  string;
  productId:       string;
  amountUsd:       number;
  currency:        string;
  metadata?:       Record<string, string>;
  subscriptionId?: string;
}

export interface PaymentIntentResult {
  providerIntentId: string;
  clientSecret?:    string;   // Stripe: for client-side confirmation
  checkoutUrl?:     string;   // Razorpay: redirect URL
  status:           string;
  rawResponse:      unknown;
}

export interface CaptureResult {
  providerIntentId: string;
  status:           PaymentStatus;
  amountCaptured:   number;
  currency:         string;
  receiptData?:     string;
}

export interface RefundResult {
  refundId:         string;
  status:           'pending' | 'succeeded' | 'failed';
  amountRefunded:   number;
}

export interface WebhookEvent {
  provider:         PaymentProvider;
  eventType:        string;
  providerEventId:  string;
  paymentIntentId?: string;
  subscriptionId?:  string;
  userId?:          string;
  amountUsd?:       number;
  rawPayload:       Record<string, unknown>;
}

export interface ReceiptValidationResult {
  valid:              boolean;
  transactionId:      string;
  originalTransactionId?: string;
  productId:          string;
  purchaseState:      'PURCHASED' | 'PENDING' | 'CANCELLED' | 'REFUNDED';
  expiresAt?:         Date;
  isSandbox:          boolean;
  rawResponse:        unknown;
}

export interface IPaymentProvider {
  name: PaymentProvider;

  // Create a payment intent / order for client-side confirmation
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult>;

  // Server-side capture after client confirmation (Stripe: auto; Razorpay: verify)
  capturePayment(providerIntentId: string, signature?: string, payload?: string): Promise<CaptureResult>;

  // Refund a completed payment
  refundPayment(providerIntentId: string, amountUsd?: number): Promise<RefundResult>;

  // Parse + verify a webhook payload; throws on invalid signature
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookEvent>;

  // Validate a mobile store receipt server-side
  validateReceipt?(token: string, productId: string): Promise<ReceiptValidationResult>;

  // Cancel a subscription at provider level
  cancelSubscription?(providerSubId: string, immediately?: boolean): Promise<void>;
}
