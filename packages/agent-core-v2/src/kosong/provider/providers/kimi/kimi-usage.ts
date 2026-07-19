/**
 * `kosong/provider` domain (L2) — Kimi usage-location trait.
 *
 * `kimiUsageTrait.extractUsage`: the usage payload of a Kimi stream chunk
 * sits either at the top level (the base's default location) or inside
 * `choices[0].usage`. Returning `undefined` defers to the base default when
 * neither position carries one.
 */

import type { ProtocolTrait } from '#/kosong/protocol/protocolTrait';

export const kimiUsageTrait: ProtocolTrait = {
  extractUsage: (chunk) => {
    const topLevel = chunk['usage'];
    if (topLevel !== null && topLevel !== undefined && typeof topLevel === 'object') {
      return topLevel as Record<string, unknown>;
    }
    const choices = chunk['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      return undefined;
    }
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const choiceUsage = firstChoice?.['usage'];
    if (choiceUsage !== null && choiceUsage !== undefined && typeof choiceUsage === 'object') {
      return choiceUsage as Record<string, unknown>;
    }
    return undefined;
  },
};
