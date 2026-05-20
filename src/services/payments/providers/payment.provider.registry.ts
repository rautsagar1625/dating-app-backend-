// ── Payment Provider Registry ─────────────────────────────────────────────────
//
// Providers register at module load time. Active provider is selected via
// PAYMENT_PROVIDER env var (default: stub). Multiple providers can be
// registered for failover — see getProviderWithFallback().

import type { IPaymentProvider, PaymentProvider } from '../payment.types';

const registry = new Map<string, () => IPaymentProvider>();

export function registerPaymentProvider(name: string, factory: () => IPaymentProvider): void {
  registry.set(name, factory);
}

export function getPaymentProvider(name?: string): IPaymentProvider {
  const providerName = name ?? process.env.PAYMENT_PROVIDER ?? 'stub';
  const factory = registry.get(providerName);
  if (!factory) throw new Error(`Payment provider "${providerName}" not registered`);
  return factory();
}

// Returns primary provider, falling back to secondary on construction error.
// Useful during provider outages (e.g. Stripe → Razorpay for INR traffic).
export function getProviderWithFallback(
  primary: PaymentProvider,
  fallback: PaymentProvider,
): IPaymentProvider {
  try {
    return getPaymentProvider(primary);
  } catch {
    return getPaymentProvider(fallback);
  }
}

// Auto-register providers. Each provider module calls registerPaymentProvider
// when imported. Use require() to trigger side effects.
export function loadAllProviders(): void {
  require('./stub.provider');
  // Only load payment providers in server environments
  if (typeof process !== 'undefined') {
    try { require('./stripe.provider');   } catch { /* optional dep */ }
    try { require('./razorpay.provider'); } catch { /* optional dep */ }
    try { require('./apple.provider');    } catch { /* optional dep */ }
    try { require('./google.provider');   } catch { /* optional dep */ }
  }
}
