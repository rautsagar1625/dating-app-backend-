// Stub text moderation provider — always approves.
// Used in development and as safe fallback when no provider is configured.

import { registerTextProvider, type TextModerationProvider } from './text.interface';
import type { TextModerationResult } from '../../../trust/trust.types';

const stubProvider: TextModerationProvider = {
  name: 'stub',
  async moderate(_text: string): Promise<TextModerationResult> {
    return {
      decision:          'CLEAN',
      confidence:        1.0,
      signals:           [],
      flaggedCategories: [],
      explanation:       'Stub provider — no ML analysis performed',
      raw:               { provider: 'stub' },
    };
  },
};

registerTextProvider('stub', () => stubProvider);

export default stubProvider;
