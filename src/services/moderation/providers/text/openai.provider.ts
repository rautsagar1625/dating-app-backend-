// OpenAI Moderation API provider
// Docs: https://platform.openai.com/docs/api-reference/moderations
// Set TEXT_MOD_PROVIDER=openai and OPENAI_API_KEY to activate.

import { registerTextProvider, type TextModerationProvider, type TextModerationContext } from './text.interface';
import type { TextModerationResult, ModerationSignal } from '../../../trust/trust.types';
import { logger } from '../../../../observability/logger';

// OpenAI moderation category → our internal threat type mapping
const CATEGORY_MAP: Record<string, string> = {
  harassment:              'HARASSMENT',
  'harassment/threatening': 'HARASSMENT',
  hate:                    'TOXIC_LANGUAGE',
  'hate/threatening':      'TOXIC_LANGUAGE',
  'self-harm':             'UNDERAGE_RISK',
  'sexual/minors':         'UNDERAGE_RISK',
  sexual:                  'ESCORT_SOLICITATION',
  violence:                'HARASSMENT',
  'violence/graphic':      'HARASSMENT',
};

const openAiProvider: TextModerationProvider = {
  name: 'openai',

  async moderate(text: string, _ctx?: TextModerationContext): Promise<TextModerationResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('OpenAI provider selected but OPENAI_API_KEY not set — falling back to clean');
      return {
        decision: 'CLEAN', confidence: 0, signals: [],
        flaggedCategories: [], explanation: 'API key missing', raw: {},
      };
    }

    let raw: Record<string, unknown> = {};
    try {
      const res = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: text }),
      });

      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
      raw = await res.json() as Record<string, unknown>;
    } catch (err) {
      logger.error({ err }, 'OpenAI moderation API call failed');
      // Fail open with ESCALATED so human reviews it
      return {
        decision: 'ESCALATED', confidence: 0, signals: [],
        flaggedCategories: ['API_ERROR'],
        explanation: 'Provider call failed — escalated for human review',
        raw: { error: String(err) },
      };
    }

    const result = (raw as any)?.results?.[0];
    if (!result) {
      return {
        decision: 'CLEAN', confidence: 1, signals: [],
        flaggedCategories: [], explanation: 'No result from OpenAI', raw,
      };
    }

    const flagged: boolean = result.flagged ?? false;
    const cats: Record<string, boolean>  = result.categories ?? {};
    const scores: Record<string, number> = result.category_scores ?? {};

    const signals: ModerationSignal[] = Object.entries(scores)
      .filter(([_, s]) => (s as number) > 0.1)
      .map(([cat, score]) => ({
        type:   CATEGORY_MAP[cat] ?? cat,
        score:  score as number,
        detail: `OpenAI category '${cat}': ${(score as number).toFixed(3)}`,
      }));

    const flaggedCategories = Object.entries(cats)
      .filter(([_, v]) => v)
      .map(([k]) => CATEGORY_MAP[k] ?? k);

    // Underage content is always REJECTED, never just warned
    const hasUnderageRisk = flaggedCategories.includes('UNDERAGE_RISK');

    const decision: TextModerationResult['decision'] =
      hasUnderageRisk ? 'REJECTED' :
      flagged         ? 'ESCALATED' :
                        'CLEAN';

    const maxScore = Math.max(0, ...Object.values(scores).map(Number));

    return {
      decision,
      confidence: maxScore,
      signals,
      flaggedCategories,
      explanation: flagged
        ? `Flagged by OpenAI: ${flaggedCategories.join(', ')}`
        : 'OpenAI: content approved',
      raw,
    };
  },
};

registerTextProvider('openai', () => openAiProvider);

export default openAiProvider;
