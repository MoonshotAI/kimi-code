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
