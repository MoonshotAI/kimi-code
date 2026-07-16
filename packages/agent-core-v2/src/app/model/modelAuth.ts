/**
 * `model` domain (L2) — shared auth-material resolution.
 *
 * Resolves Model / Provider / Platform credential precedence for runtime
 * model resolution and auth-readiness probes. Pure computation; callers
 * supply the Platform lookup so this file stays outside the service graph.
 * The inferred Anthropic effort profile is reserved for non-Kimi
 * Anthropic-compatible providers; Kimi providers — including managed models
 * routed through protocol = "anthropic" — keep only catalog-declared effort
 * metadata.
 */

import { ErrorCodes, Error2 } from '#/errors';
import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  matchKnownAnthropicModelProfile,
} from '#/app/llmProtocol/providers/anthropic-profile';
import { type PlatformConfig, UNKNOWN_PLATFORM_KEY } from '#/app/platform/platform';
import type { OAuthRef, ProviderConfig, ProviderType } from '#/app/provider/provider';
import type { Protocol } from '#/app/protocol/protocol';

import type { ModelConfig } from './model';

export interface ResolvedModelAuthMaterial {
  readonly apiKey?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

export function resolveModelAuthMaterial(args: {
  readonly modelId: string;
  readonly model: ModelConfig;
  readonly provider: ProviderConfig | undefined;
  readonly providerName: string;
  readonly getPlatform: (platformId: string) => PlatformConfig | undefined;
}): ResolvedModelAuthMaterial {
  const modelApiKey = nonEmpty(args.model.apiKey);
  if (modelApiKey !== undefined && args.model.oauth !== undefined) {
    throw authConflictError('Model', args.modelId);
  }
  if (modelApiKey !== undefined) return { apiKey: modelApiKey };
  if (args.model.oauth !== undefined) {
    return {
      oauth: args.model.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }

  const platformId = args.provider?.platformId;
  if (platformId !== undefined && platformId !== UNKNOWN_PLATFORM_KEY) {
    const platform = args.getPlatform(platformId);
    const authType = args.provider?.type ?? args.model.protocol;
    const platformApiKey =
      nonEmpty(platform?.auth?.apiKey) ??
      providerApiKeyEnvFallback(authType, platform?.auth?.env);
    if (platformApiKey !== undefined && platform?.auth?.oauth !== undefined) {
      throw authConflictError('Platform', platformId);
    }
    if (platformApiKey !== undefined) return { apiKey: platformApiKey };
    if (platform?.auth?.oauth !== undefined) {
      return { oauth: platform.auth.oauth, oauthProviderKey: platformId };
    }
  }

  const providerApiKey =
    nonEmpty(args.provider?.apiKey) ??
    providerApiKeyEnvFallback(args.provider?.type ?? args.model.protocol, args.provider?.env);
  if (providerApiKey !== undefined && args.provider?.oauth !== undefined) {
    throw authConflictError('Provider', args.providerName);
  }
  if (providerApiKey !== undefined) return { apiKey: providerApiKey };
  if (args.provider?.oauth !== undefined) {
    return {
      oauth: args.provider.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }
  return {};
}

export function effectiveModelConfig(
  model: ModelConfig,
  providerType?: ProviderType,
): ModelConfig {
  const { overrides, ...base } = model;
  const effective: ModelConfig = overrides === undefined ? model : { ...base, ...overrides };
  if (
    overrides?.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }
  return withAnthropicProfile(effective, providerType);
}

function withAnthropicProfile(model: ModelConfig, providerType?: ProviderType): ModelConfig {
  const wireName = model.name ?? model.model;
  const protocol = model.protocol ?? providerType;
  const profile =
    wireName === undefined
      ? undefined
      : providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
        ? inferAnthropicModelProfile(wireName)
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

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function providerApiKeyEnvFallback(
  protocol: Protocol | undefined,
  env: Record<string, string> | undefined,
): string | undefined {
  if (protocol === undefined) return undefined;
  switch (protocol) {
    case 'anthropic':
      return nonEmpty(env?.['ANTHROPIC_API_KEY']);
    case 'openai':
    case 'openai_responses':
      return nonEmpty(env?.['OPENAI_API_KEY']);
    case 'kimi':
      return nonEmpty(env?.['KIMI_API_KEY']);
    case 'google-genai':
      return nonEmpty(env?.['GOOGLE_API_KEY']);
    case 'vertexai':
      return nonEmpty(env?.['VERTEXAI_API_KEY']) ?? nonEmpty(env?.['GOOGLE_API_KEY']);
    default: {
      const exhaustive: never = protocol;
      return exhaustive;
    }
  }
}

function authConflictError(kind: string, name: string): Error2 {
  return new Error2(
    ErrorCodes.CONFIG_INVALID,
    `${kind} "${name}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`,
  );
}
