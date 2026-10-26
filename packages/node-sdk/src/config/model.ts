import { resolveModelProtocol } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model-auth';
import { resolveProtocolCapability } from '@moonshot-ai/agent-core-v2/llm-adapter/protocol/protocolAdapterRegistry';
import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '@moonshot-ai/kosong/providers/anthropic-profile';

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

  return withRuntimeThinkingCapabilities(withAnthropicProfile(clamped, providerType), providerType);
}

function withRuntimeThinkingCapabilities(model: ModelAlias, providerType?: ProviderType): ModelAlias {
  const capabilities = model.capabilities?.map((capability) => {
    const normalized = capability.trim().toLowerCase();
    return normalized === 'thinking' || normalized === 'always_thinking' ? normalized : capability;
  }) ?? [];
  const protocol = resolveModelProtocol(model, providerType === undefined ? undefined : { type: providerType });
  if (
    protocol !== undefined &&
    resolveProtocolCapability(protocol, model.model, providerType).thinking &&
    !capabilities.includes('thinking') &&
    !capabilities.includes('always_thinking')
  ) {
    capabilities.push('thinking');
  }
  return model.capabilities === undefined && capabilities.length === 0
    ? model
    : { ...model, capabilities };
}

function withAnthropicProfile(model: ModelAlias, providerType?: ProviderType): ModelAlias {
  const protocol = model.protocol ?? providerType;
  const profile =
    providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
      ? (matchKnownAnthropicModelProfile(model.model) ?? matchUnknownClaudeProfile(model.model))
      : matchKnownAnthropicModelProfile(model.model);
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
