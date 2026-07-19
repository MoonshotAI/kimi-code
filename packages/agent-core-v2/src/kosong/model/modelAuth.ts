/**
 * `kosong/model` domain (L2) — shared auth-material resolution.
 *
 * Resolves Model / Provider / Platform credential precedence for runtime
 * model resolution and auth-readiness probes. Pure computation; callers
 * supply the Platform lookup so this file stays outside the service graph.
 *
 * Two deliberate differences from the legacy implementation:
 *  - The per-protocol env-var fallback table is gone: env-bag credential and
 *    endpoint resolution goes through the provider-definition registry
 *    (`resolveProviderEndpoint` against the config env bag).
 *  - The inferred Anthropic effort profile is reserved for providers whose
 *    thinking is NOT trait-driven; trait-driven providers — including
 *    managed models routed through protocol `anthropic` — keep only
 *    catalog-declared effort metadata. The verdict comes from the registry
 *    (`drivesThinkingThroughTraits`), not from a vendor string compare.
 */

import { Error2 } from '#/_base/errors/errors';
import { type PlatformConfig, UNKNOWN_PLATFORM_KEY } from '#/app/platform/platform';

import { ConfigErrors } from '../../app/config/errors';
import {
  BUDGET_THINKING_EFFORTS,
  inferAnthropicModelProfile,
  matchKnownAnthropicModelProfile,
} from '../provider/bases/anthropic-profile';
import type { OAuthRef, ProviderConfig } from '../provider/provider';
import { resolveProviderEndpoint } from '../provider/providerDefinition';

import type { ModelRecord } from './model';
import { drivesThinkingThroughTraits } from './thinking';

export interface ResolvedModelAuthMaterial {
  readonly apiKey?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

export function resolveModelAuthMaterial(args: {
  readonly modelId: string;
  readonly model: ModelRecord;
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
      nonEmpty(platform?.auth?.apiKey) ?? envApiKeyFallback(authType, platform?.auth?.env);
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
    envApiKeyFallback(args.provider?.type ?? args.model.protocol, args.provider?.env);
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
  return withAnthropicProfile(effective, providerType);
}

function withAnthropicProfile(model: ModelRecord, providerType?: string): ModelRecord {
  const wireName = model.name ?? model.model;
  const protocol = model.protocol ?? providerType;
  const profile =
    wireName === undefined
      ? undefined
      : providerType !== undefined && !drivesThinkingThroughTraits(providerType) && protocol === 'anthropic'
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

/**
 * Env-bag credential fallback through the provider-definition registry: the
 * vendor's declared `apiKeyEnv` chain, read from the config env bag. Returns
 * `undefined` for unregistered vendors and for vendors without an endpoint
 * declaration (their bases fall back to `process.env` at construction).
 */
function envApiKeyFallback(
  authType: string | undefined,
  env: Record<string, string> | undefined,
): string | undefined {
  if (authType === undefined) return undefined;
  return nonEmpty(resolveProviderEndpoint(authType, env ?? {}).apiKey);
}

function authConflictError(kind: string, name: string): Error2 {
  return new Error2(
    ConfigErrors.codes.CONFIG_INVALID,
    `${kind} "${name}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`,
  );
}
