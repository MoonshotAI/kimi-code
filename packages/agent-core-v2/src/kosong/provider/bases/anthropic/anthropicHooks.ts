/**
 * `kosong/provider` domain (L2) — the ONLY composition point from resolved
 * traits to the Anthropic hook set.
 *
 * The Anthropic base has two hooks. `withThinking` takes the LAST declarer
 * and wraps it with a defensive kwargs copy — so a hook can never mutate base
 * state, and a synthetic construction-headers trait (which never declares
 * `withThinking`) can never shadow a real dialect hook. `convertError` is the
 * shared single-value binding from `traitConvertError` (last declarer wins),
 * consulted by the base's error converter after the abort guard.
 */

import { traitConvertError, type ResolvedTrait } from '#/kosong/protocol/protocolTrait';

import type { AnthropicHooks } from './anthropic';

export function composeAnthropicHooks(
  traits: readonly ResolvedTrait[],
): AnthropicHooks | undefined {
  const hooks: AnthropicHooks = {};

  const thinkingTraits = traits.filter(({ trait }) => trait.withThinking !== undefined);
  if (thinkingTraits.length > 0) {
    const { trait, context } = thinkingTraits.at(-1)!;
    hooks.withThinking = (effort, options, kwargs) =>
      trait.withThinking!(effort, options, { ...kwargs }, context);
  }

  const convertError = traitConvertError(traits);
  if (convertError !== undefined) {
    hooks.convertError = convertError;
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
