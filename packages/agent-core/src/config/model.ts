import {
  inferAnthropicModelProfile,
  matchKnownAnthropicModelProfile,
} from '@moonshot-ai/kosong/providers/anthropic-profile';

import type { ModelAlias } from './schema';

export function effectiveModelAlias(
  alias: ModelAlias,
  anthropicCompatible = false,
): ModelAlias {
  const { overrides, ...base } = alias;
  const effective: ModelAlias = overrides === undefined ? alias : { ...base, ...overrides };

  if (
    overrides?.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }

  return withAnthropicProfile(effective, anthropicCompatible);
}

function withAnthropicProfile(model: ModelAlias, anthropicCompatible: boolean): ModelAlias {
  const profile = anthropicCompatible
    ? inferAnthropicModelProfile(model.model)
    : matchKnownAnthropicModelProfile(model.model);
  if (profile === undefined) return model;

  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
  const supportEfforts = model.supportEfforts ?? [...profile.efforts];

  return {
    ...model,
    capabilities: hasCapability ? capabilities : [...capabilities, capability],
    supportEfforts,
    defaultEffort:
      model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
  };
}

export function effectiveModelAliases(
  models: Record<string, ModelAlias>,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, effectiveModelAlias(model)]),
  );
}
