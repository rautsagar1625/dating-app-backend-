// SightEngine NSFW provider
// API: https://sightengine.com/docs/nudity-detection
// Set NSFW_PROVIDER=sightengine, SIGHTENGINE_USER, SIGHTENGINE_SECRET

import { registerNsfwProvider, type NsfwProvider, type NsfwScanResult } from './nsfw.registry';
import { logger } from '../../../../observability/logger';

const SE_API = 'https://api.sightengine.com/1.0/check.json';

const sightengineProvider: NsfwProvider = {
  name: 'sightengine',

  async scan(imageBuffer: Buffer): Promise<NsfwScanResult> {
    const user   = process.env.SIGHTENGINE_USER;
    const secret = process.env.SIGHTENGINE_SECRET;

    if (!user || !secret) {
      logger.warn('SIGHTENGINE_USER / SIGHTENGINE_SECRET not set');
      return { isNsfw: false, nsfwScore: 0, underageRisk: false, violenceScore: 0, labels: [], raw: {}, provider: 'sightengine' };
    }

    try {
      const form = new FormData();
      form.append('media',   new Blob([new Uint8Array(imageBuffer)]), 'image.jpg');
      form.append('models',  'nudity-2.1,offensive,gore');
      form.append('api_user', user);
      form.append('api_secret', secret);

      const res = await fetch(SE_API, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`SightEngine ${res.status}: ${await res.text()}`);

      const raw = await res.json() as Record<string, unknown>;
      const nudity  = (raw as any)?.nudity ?? {};
      const gore    = (raw as any)?.gore ?? {};
      const offensive = (raw as any)?.offensive ?? {};

      // SightEngine nudity scores
      const explicitScore = Math.max(
        nudity.sexual_activity ?? 0,
        nudity.sexual_display  ?? 0,
        nudity.erotica         ?? 0,
      );
      const underageScore = nudity.minors ?? 0;
      const violenceScore = gore.prob ?? offensive.prob ?? 0;

      const labels: string[] = [];
      if (explicitScore > 0.4) labels.push('explicit_nudity');
      if (underageScore > 0.3) labels.push('underage_risk');
      if (violenceScore > 0.4) labels.push('violence');

      return {
        isNsfw:       explicitScore >= 0.6 || underageScore > 0.3,
        nsfwScore:    explicitScore,
        underageRisk: underageScore > 0.3,
        violenceScore,
        labels,
        raw,
        provider: 'sightengine',
      };
    } catch (err) {
      logger.error({ err }, 'SightEngine scan failed');
      return { isNsfw: false, nsfwScore: 0.5, underageRisk: false, violenceScore: 0, labels: ['SCAN_ERROR'], raw: { error: String(err) }, provider: 'sightengine' };
    }
  },
};

// Stub provider (default safe fallback)
const stubNsfwProvider: NsfwProvider = {
  name: 'stub',
  async scan(_buf: Buffer): Promise<NsfwScanResult> {
    return { isNsfw: false, nsfwScore: 0, underageRisk: false, violenceScore: 0, labels: [], raw: { provider: 'stub' }, provider: 'stub' };
  },
};

registerNsfwProvider('sightengine', () => sightengineProvider);
registerNsfwProvider('stub',        () => stubNsfwProvider);

export { stubNsfwProvider };
export default sightengineProvider;
