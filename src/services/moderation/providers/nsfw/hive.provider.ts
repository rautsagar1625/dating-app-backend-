// Hive Moderation provider
// API: https://docs.thehive.ai/docs/visual-moderation
// Set NSFW_PROVIDER=hive and HIVE_API_KEY

import { registerNsfwProvider, type NsfwProvider, type NsfwScanResult } from './nsfw.registry';
import { logger } from '../../../../observability/logger';

const HIVE_API = 'https://api.thehive.ai/api/v2/task/sync';

// Hive class → internal category mapping (simplified)
const NSFW_CLASSES = new Set([
  'general_nsfw', 'general_suggestive', 'yes_female_nudity',
  'yes_male_nudity', 'yes_sexual_activity', 'yes_explicit',
]);

const UNDERAGE_CLASSES = new Set(['yes_underage', 'yes_minor_suggestive']);
const VIOLENCE_CLASSES = new Set(['yes_violence', 'yes_gore', 'yes_weapon']);

const hiveProvider: NsfwProvider = {
  name: 'hive',

  async scan(imageBuffer: Buffer): Promise<NsfwScanResult> {
    const apiKey = process.env.HIVE_API_KEY;
    if (!apiKey) {
      logger.warn('HIVE_API_KEY not set — falling back to clean result');
      return { isNsfw: false, nsfwScore: 0, underageRisk: false, violenceScore: 0, labels: [], raw: {}, provider: 'hive' };
    }

    try {
      const formData = new FormData();
      formData.append('media', new Blob([new Uint8Array(imageBuffer)]), 'image.jpg');

      const res = await fetch(HIVE_API, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}` },
        body: formData,
      });

      if (!res.ok) throw new Error(`Hive API ${res.status}: ${await res.text()}`);

      const raw = await res.json() as Record<string, unknown>;
      const classes: Array<{ class: string; score: number }> =
        (raw as any)?.status?.[0]?.response?.output?.[0]?.classes ?? [];

      let nsfwScore = 0;
      let violenceScore = 0;
      let underageRisk = false;
      const labels: string[] = [];

      for (const c of classes) {
        if (NSFW_CLASSES.has(c.class))      nsfwScore     = Math.max(nsfwScore, c.score);
        if (UNDERAGE_CLASSES.has(c.class))  underageRisk  = c.score > 0.5;
        if (VIOLENCE_CLASSES.has(c.class))  violenceScore = Math.max(violenceScore, c.score);
        if (c.score > 0.4) labels.push(c.class);
      }

      return { isNsfw: nsfwScore >= 0.6 || underageRisk, nsfwScore, underageRisk, violenceScore, labels, raw, provider: 'hive' };
    } catch (err) {
      logger.error({ err }, 'Hive scan failed');
      return { isNsfw: false, nsfwScore: 0.5, underageRisk: false, violenceScore: 0, labels: ['SCAN_ERROR'], raw: { error: String(err) }, provider: 'hive' };
    }
  },
};

registerNsfwProvider('hive', () => hiveProvider);

export default hiveProvider;
