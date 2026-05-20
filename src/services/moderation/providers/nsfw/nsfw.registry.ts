// ── NSFW provider registry ────────────────────────────────────────────────────
//
// Extends the existing NsfwProvider interface used in media/moderation.service.ts
// with a provider registry pattern. Set NSFW_PROVIDER env var to activate:
//
//   NSFW_PROVIDER=stub        (default — always passes)
//   NSFW_PROVIDER=rekognition (AWS Rekognition)
//   NSFW_PROVIDER=hive        (Hive Moderation)
//   NSFW_PROVIDER=sightengine (SightEngine)
//
// Providers can be chained (multi-pass) by setting NSFW_PROVIDER=rekognition,hive
// The strictest decision wins.

export interface NsfwScanResult {
  isNsfw:        boolean;
  nsfwScore:     number;         // 0.0–1.0
  underageRisk:  boolean;
  violenceScore: number;         // 0.0–1.0
  labels:        string[];
  raw:           Record<string, unknown>;
  provider:      string;
}

export interface NsfwProvider {
  readonly name: string;
  scan(imageBuffer: Buffer): Promise<NsfwScanResult>;
}

const _registry = new Map<string, () => NsfwProvider>();

export function registerNsfwProvider(name: string, factory: () => NsfwProvider): void {
  _registry.set(name, factory);
}

export function getNsfwProvider(): NsfwProvider {
  const cfg = (process.env.NSFW_PROVIDER ?? 'stub').toLowerCase();
  const name = cfg.split(',')[0].trim();
  const factory = _registry.get(name) ?? _registry.get('stub')!;
  return factory();
}

// Multi-provider chain: all providers are called; strictest decision wins
export async function runNsfwChain(imageBuffer: Buffer): Promise<NsfwScanResult> {
  const cfg = (process.env.NSFW_PROVIDER ?? 'stub').toLowerCase();
  const names = cfg.split(',').map((n) => n.trim());

  const results = await Promise.all(
    names.map((n) => {
      const factory = _registry.get(n) ?? _registry.get('stub')!;
      return factory().scan(imageBuffer).catch((err) => {
        const stub: NsfwScanResult = {
          isNsfw: false, nsfwScore: 0, underageRisk: false,
          violenceScore: 0, labels: ['ERROR'], raw: { error: String(err) },
          provider: n,
        };
        return stub;
      });
    }),
  );

  // Return the most conservative result
  return results.reduce((worst, curr) =>
    curr.nsfwScore > worst.nsfwScore || curr.underageRisk ? curr : worst,
  );
}
