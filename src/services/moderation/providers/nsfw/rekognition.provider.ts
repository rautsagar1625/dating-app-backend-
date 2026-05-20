// AWS Rekognition NSFW provider
// Requires: @aws-sdk/client-rekognition
// Set NSFW_PROVIDER=rekognition, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

import { registerNsfwProvider, type NsfwProvider, type NsfwScanResult } from './nsfw.registry';
import { logger } from '../../../../observability/logger';

// Rekognition moderation label → our internal category
const NSFW_LABELS = new Set([
  'Explicit Nudity', 'Nudity', 'Graphic Male Nudity', 'Graphic Female Nudity',
  'Sexual Activity', 'Illustrated Explicit Nudity', 'Adult Toys',
]);

const UNDERAGE_LABELS = new Set([
  'Suggestive', 'Non-Explicit Nudity of Minors',
]);

const VIOLENCE_LABELS = new Set([
  'Violence', 'Graphic Violence Or Gore', 'Physical Violence', 'Weapon Violence',
]);

const rekognitionProvider: NsfwProvider = {
  name: 'rekognition',

  async scan(imageBuffer: Buffer): Promise<NsfwScanResult> {
    let RekognitionClient: any, DetectModerationLabelsCommand: any;
    try {
      // @ts-expect-error optional peer dependency — install with: npm i @aws-sdk/client-rekognition
      const mod = await import('@aws-sdk/client-rekognition');
      RekognitionClient = mod.RekognitionClient;
      DetectModerationLabelsCommand = mod.DetectModerationLabelsCommand;
    } catch {
      logger.warn('AWS Rekognition SDK not installed — run: npm i @aws-sdk/client-rekognition');
      return { isNsfw: false, nsfwScore: 0, underageRisk: false, violenceScore: 0, labels: [], raw: { error: 'SDK_NOT_INSTALLED' }, provider: 'rekognition' };
    }

    try {
      const client = new RekognitionClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
      const cmd = new DetectModerationLabelsCommand({
        Image: { Bytes: imageBuffer },
        MinConfidence: 50,
      });

      const response = await client.send(cmd);
      const labels: any[] = response.ModerationLabels ?? [];
      const labelNames = labels.map((l: any) => l.Name as string);

      let nsfwScore = 0;
      let violenceScore = 0;
      let underageRisk = false;

      for (const l of labels) {
        const conf = (l.Confidence as number) / 100;
        if (NSFW_LABELS.has(l.Name))      nsfwScore     = Math.max(nsfwScore, conf);
        if (UNDERAGE_LABELS.has(l.Name))  underageRisk  = conf > 0.6;
        if (VIOLENCE_LABELS.has(l.Name))  violenceScore = Math.max(violenceScore, conf);
      }

      return {
        isNsfw:       nsfwScore >= 0.6 || underageRisk,
        nsfwScore,
        underageRisk,
        violenceScore,
        labels:       labelNames,
        raw:          response as unknown as Record<string, unknown>,
        provider:     'rekognition',
      };
    } catch (err) {
      logger.error({ err }, 'Rekognition scan failed');
      // Fail safe: escalate for human review
      return { isNsfw: false, nsfwScore: 0.5, underageRisk: false, violenceScore: 0, labels: ['SCAN_ERROR'], raw: { error: String(err) }, provider: 'rekognition' };
    }
  },
};

registerNsfwProvider('rekognition', () => rekognitionProvider);

export default rekognitionProvider;
