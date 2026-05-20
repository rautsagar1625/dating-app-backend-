// ── Call Provider Registry ────────────────────────────────────────────────────
//
// Provider is selected via CALL_PROVIDER env var.
// Register providers with registerCallProvider(); get active one with getCallProvider().
//
// Supported values: stub | agora | livekit | twilio
// Defaults to stub if env var not set or value unknown.

import type { CallProvider } from '../call.types';

const _registry = new Map<string, () => CallProvider>();

export function registerCallProvider(name: string, factory: () => CallProvider): void {
  _registry.set(name.toLowerCase(), factory);
}

export function getCallProvider(): CallProvider {
  // Import providers to trigger their self-registration
  require('./stub.provider');
  try { require('./agora.provider');    } catch { /* optional */ }
  try { require('./livekit.provider');  } catch { /* optional */ }
  try { require('./twilio.provider');   } catch { /* optional */ }

  const name    = (process.env.CALL_PROVIDER ?? 'stub').toLowerCase();
  const factory = _registry.get(name) ?? _registry.get('stub')!;
  return factory();
}
