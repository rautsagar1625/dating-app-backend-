// ── Text moderation provider interface ───────────────────────────────────────
//
// Any text moderation backend (OpenAI, Perspective, custom ML) must implement
// this interface. The registry picks the active provider via TEXT_MOD_PROVIDER
// env var. Unknown values fall back to the stub provider.

import type { TextModerationResult } from '../../../trust/trust.types';

export interface TextModerationContext {
  chatId?:       string;
  senderId?:     string;
  priorMessages?: string[];  // last N messages for conversation context
}

export interface TextModerationProvider {
  readonly name: string;
  moderate(
    text:    string,
    context?: TextModerationContext,
  ): Promise<TextModerationResult>;
}

// ── Provider registry ─────────────────────────────────────────────────────────

const _registry = new Map<string, () => TextModerationProvider>();

export function registerTextProvider(
  name: string,
  factory: () => TextModerationProvider,
): void {
  _registry.set(name, factory);
}

export function getTextProvider(): TextModerationProvider {
  const name = (process.env.TEXT_MOD_PROVIDER ?? 'stub').toLowerCase();
  const factory = _registry.get(name) ?? _registry.get('stub')!;
  return factory();
}
