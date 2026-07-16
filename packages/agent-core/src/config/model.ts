import {
  BUDGET_THINKING_EFFORTS,
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

  return withAnthropicProfile(
    effective,
    anthropicCompatible || effective.protocol === 'anthropic',
  );
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
  // `adaptive_thinking = false` opts the endpoint out of the adaptive API, so
  // the catalog must not advertise adaptive-only efforts (xhigh/max) — this
  // mirrors the budget branch of kosong's resolveThinkingProfile.
  const supportEfforts =
    model.supportEfforts ??
    (model.adaptiveThinking === false ? [...BUDGET_THINKING_EFFORTS] : [...profile.efforts]);

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
