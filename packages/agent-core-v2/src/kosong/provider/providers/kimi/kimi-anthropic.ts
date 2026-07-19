/**
 * `kosong/provider` domain (L2) — Kimi-over-Anthropic thinking dialect.
 *
 * `kimiAnthropicThinkingTrait` is the sole `dialects.anthropic` slice: when a
 * Kimi model runs over the Anthropic transport, the thinking intent is
 * encoded as `thinking: { type: 'enabled' }` plus `output_config.effort`, and
 * the interleaved-thinking beta is stripped from the seeded beta list. The
 * `keep` dimension needs no dialect handling — the Anthropic base overlays
 * the context-management edit itself.
 */

import type { ProtocolTrait } from '#/kosong/protocol/protocolTrait';

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

export const kimiAnthropicThinkingTrait: ProtocolTrait = {
  withThinking: (effort, _options, generationKwargs) => {
    const seeded = generationKwargs['betaFeatures'];
    const betaFeatures = (Array.isArray(seeded) ? (seeded as string[]) : []).filter(
      (beta) => beta !== INTERLEAVED_THINKING_BETA,
    );
    if (effort === 'off') {
      return {
        thinking: { type: 'disabled' },
        output_config: undefined,
        betaFeatures,
      };
    }
    return {
      thinking: { type: 'enabled' },
      output_config: effort === 'on' ? undefined : { effort },
      betaFeatures,
    };
  },
};
