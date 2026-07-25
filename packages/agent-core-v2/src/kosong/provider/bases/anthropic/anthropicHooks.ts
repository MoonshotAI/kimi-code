/**
 * `kosong/provider` domain (L2) — the ONLY composition point from resolved
 * traits to the Anthropic hook set.
 *
 * The Anthropic base has a single hook, `withThinking`. The compositor takes
 * the LAST declarer and wraps it with a defensive kwargs copy — so a hook can
 * never mutate base state, and a synthetic construction-headers trait (which
 * never declares `withThinking`) can never shadow a real dialect hook.
 */

import type { ResolvedTrait } from '#/kosong/protocol/protocolTrait';

import type { AnthropicHooks } from './anthropic';

export function composeAnthropicHooks(
  traits: readonly ResolvedTrait[],
): AnthropicHooks | undefined {
  const thinkingTraits = traits.filter(({ trait }) => trait.withThinking !== undefined);
  if (thinkingTraits.length === 0) return undefined;
  const { trait, context } = thinkingTraits.at(-1)!;
  return {
    withThinking: (effort, options, kwargs) =>
      trait.withThinking!(effort, options, { ...kwargs }, context),
  };
}
