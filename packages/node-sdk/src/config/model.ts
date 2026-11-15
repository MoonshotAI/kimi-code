import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '@moonshot-ai/core/llm/builtin/protocol/anthropic/legalize';

import type { ModelAlias, ProviderType } from './schema';

export function effectiveModelAlias(
  alias: ModelAlias,
  providerType?: ProviderType,
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

  const clamped =
    effective.maxInputSize !== undefined && effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;

  return withAnthropicProfile(clamped, providerType);
}

function withAnthropicProfile(model: ModelAlias, providerType?: ProviderType): ModelAlias {
  const modelName: string | undefined = model.model;
  if (modelName === undefined) return model;
  const protocol = model.protocol ?? providerType;
  const profile =
    providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
      ? (matchKnownAnthropicModelProfile(modelName) ?? matchUnknownClaudeProfile(modelName))
      : matchKnownAnthropicModelProfile(modelName);
  if (profile === undefined) return model;

  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
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
