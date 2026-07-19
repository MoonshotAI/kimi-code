/**
 * `kosong/provider` domain (L2) — the trait of the `(kimi, anthropic)`
 * registration.
 *
 * `kimiAnthropicThinkingTrait` is the sole trait of Kimi's Anthropic-transport
 * registration: when a Kimi model runs over the Anthropic transport, the
 * thinking intent is encoded as `thinking: { type: 'enabled' }` plus
 * `output_config.effort`, and the interleaved-thinking beta is stripped from
 * the seeded beta list. The `keep` dimension needs no trait handling — the
 * Anthropic base overlays the context-management edit itself.
 *
 * It deliberately does NOT declare `strictThinkingValidation`: over this
 * foreign transport the backend may accept efforts the local catalog metadata
 * does not list, so client-side validation stays lenient (warning +
 * pass-through) — see `kimiParamsTrait` for the strict side of the v1 parity
 * contract.
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
