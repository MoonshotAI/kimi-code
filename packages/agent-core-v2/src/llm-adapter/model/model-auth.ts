import { Error2 } from '#/_base/errors/errors';
import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '#human/llm/requester/bases/anthropic/profile';

import { CONFIG_INVALID_ERROR_CODE } from '../contract/errors';
import { ProtocolSchema, type Protocol } from '../protocol/protocol';
import type { ProviderConfig } from '../provider/provider';
import { explainProviderEndpoint, getProviderDefinition } from '../provider/provider-definition';

import type { ModelRecord } from './model';
import type { ResolvedModelAuthMaterial } from './model.types';
import { drivesThinkingThroughTraits } from './thinking';

export function resolveModelAuthMaterial(args: {
  readonly modelId: string;
  readonly model: ModelRecord;
  readonly provider: ProviderConfig | undefined;
  readonly providerName: string;
}): ResolvedModelAuthMaterial {
  const modelApiKey = nonEmpty(args.model.apiKey);
  if (modelApiKey !== undefined && args.model.oauth !== undefined) {
    throw authConflictError('Model', args.modelId);
  }
  if (modelApiKey !== undefined) {
    return { apiKey: modelApiKey };
  }
  if (args.model.oauth !== undefined) {
    return {
      oauth: args.model.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }

  const providerAuthType = args.provider?.type ?? args.model.protocol;
  const providerEndpoint =
    providerAuthType === undefined
      ? {}
      : explainProviderEndpoint(providerAuthType, args.provider?.env ?? {});
  const providerApiKey = nonEmpty(args.provider?.apiKey) ?? nonEmpty(providerEndpoint.apiKey);
  if (providerApiKey !== undefined && args.provider?.oauth !== undefined) {
    throw authConflictError('Provider', args.providerName);
  }
  if (providerApiKey !== undefined) {
    return { apiKey: providerApiKey };
  }
  if (args.provider?.oauth !== undefined) {
    return {
      oauth: args.provider.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }
  return {};
}

export function effectiveModelConfig(
  model: ModelRecord,
  providerType?: string,
): ModelRecord {
  const { overrides, ...base } = model;
  const effective: ModelRecord = overrides === undefined ? model : { ...base, ...overrides };
  if (
    overrides?.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }
  const clamped =
    effective.maxInputSize !== undefined &&
    effective.maxContextSize !== undefined &&
    effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;
  return withAnthropicProfile(clamped, providerType);
}

export function withAnthropicProfile(model: ModelRecord, providerType?: string): ModelRecord {
  const wireName = model.name ?? model.model;
  const protocol = model.protocol ?? providerType;
  const profile =
    wireName === undefined
      ? undefined
      : providerType !== undefined && !drivesThinkingThroughTraits(providerType) && protocol === 'anthropic'
        ? (matchKnownAnthropicModelProfile(wireName) ?? matchUnknownClaudeProfile(wireName))
        : matchKnownAnthropicModelProfile(wireName);
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

export function deriveProviderId(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    return baseUrl;
  }
}

export function providerNameFromFlatModel(model: ModelRecord): string | undefined {
  const baseUrl = nonEmpty(model.baseUrl);
  return baseUrl === undefined ? undefined : deriveProviderId(baseUrl);
}

export function resolveModelProtocol(
  model: ModelRecord,
  provider: ProviderConfig | undefined,
): Protocol | undefined {
  if (model.protocol !== undefined) {
    return model.protocol;
  }
  const providerType = provider?.type;
  if (providerType !== undefined) {
    const asProtocol = ProtocolSchema.safeParse(providerType);
    if (asProtocol.success) {
      return asProtocol.data;
    }
    const definition = getProviderDefinition(providerType);
    if (definition !== undefined) {
      return definition.baseProtocol;
    }
  }
  return undefined;
}

export function resolveEndpointBaseUrl(
  model: ModelRecord,
  provider: ProviderConfig,
): string | undefined {
  const fromModel = nonEmpty(model.baseUrl);
  if (fromModel !== undefined) {
    return fromModel;
  }
  const fromProvider = nonEmpty(provider.baseUrl);
  if (fromProvider !== undefined) {
    return fromProvider;
  }
  const endpointType = provider.type ?? model.protocol;
  const endpoint =
    endpointType === undefined ? {} : explainProviderEndpoint(endpointType, provider.env ?? {});
  return nonEmpty(endpoint.baseUrl);
}

export type ModelReadyFailureReason =
  | 'no-default'
  | 'dangling-alias'
  | 'provider-missing'
  | 'unresolvable';

export type ModelReadyResolution =
  | { readonly resolved: true }
  | { readonly resolved: false; readonly reason: ModelReadyFailureReason };

export function resolveModelForReady(
  modelId: string | undefined,
  models: Readonly<Record<string, ModelRecord>>,
  providers: Readonly<Record<string, ProviderConfig>>,
  defaultProvider?: string,
): ModelReadyResolution {
  if (modelId === undefined || modelId.trim().length === 0) {
    return { resolved: false, reason: 'no-default' };
  }
  const configured = models[modelId];
  if (configured === undefined) {
    return { resolved: false, reason: 'dangling-alias' };
  }
  const model = effectiveModelConfig(configured);
  const fallbackProvider =
    defaultProvider === undefined || defaultProvider.trim().length === 0 ? undefined : defaultProvider;
  const providerId = model.providerId ?? model.provider ?? fallbackProvider;
  const provider = providerId === undefined ? undefined : providers[providerId];
  if (providerId !== undefined && provider === undefined) {
    return { resolved: false, reason: 'provider-missing' };
  }
  const providerName = providerId ?? providerNameFromFlatModel(model);
  if (providerName === undefined) {
    return { resolved: false, reason: 'unresolvable' };
  }
  if (nonEmpty(model.name ?? model.model) === undefined) {
    return { resolved: false, reason: 'unresolvable' };
  }
  const maxContextSize = model.maxContextSize;
  if (maxContextSize === undefined || maxContextSize <= 0) {
    return { resolved: false, reason: 'unresolvable' };
  }
  if (resolveModelProtocol(model, provider) === undefined) {
    return { resolved: false, reason: 'unresolvable' };
  }
  return { resolved: true };
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function authConflictError(kind: string, name: string): Error2 {
  return new Error2(
    CONFIG_INVALID_ERROR_CODE,
    `${kind} "${name}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`,
  );
}
