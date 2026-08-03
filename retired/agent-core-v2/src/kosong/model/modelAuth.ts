/**
 * `kosong/model` domain (L2) — shared auth-material resolution.
 *
 * Resolves Model / Provider credential precedence for runtime model
 * resolution and auth-readiness probes. Pure computation, outside the
 * service graph.
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
 *    The unknown-name fallback within that inference only applies to names
 *    that still carry a Claude marker (a `claude` substring or a bare family
 *    word like `sonnet-latest`); clearly non-Claude names served over the
 *    Anthropic protocol get no synthesized effort metadata.
 */

import { Error2 } from '#/_base/errors/errors';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import type { ResolutionTrace } from '#/kosong/contract/inspection';

import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '../provider/bases/anthropic/anthropic-profile';
import type { ProviderConfig } from '../provider/provider';
import { explainProviderEndpoint } from '../provider/providerDefinition';

import type { ModelRecord } from './model';
import type { ResolvedModelAuthMaterial } from './model.types';
import { drivesThinkingThroughTraits } from './thinking';

/**
 * The Model → Provider credential precedence chain. When `trace` is given,
 * the winning layer (and any env-bag hit, by env-var name) is recorded at
 * `resolved.auth`; without a trace the function is the pure chain it always
 * was.
 */
export function resolveModelAuthMaterial(
  args: {
    readonly modelId: string;
    readonly model: ModelRecord;
    readonly provider: ProviderConfig | undefined;
    readonly providerName: string;
  },
  trace?: ResolutionTrace,
): ResolvedModelAuthMaterial {
  const modelApiKey = nonEmpty(args.model.apiKey);
  if (modelApiKey !== undefined && args.model.oauth !== undefined) {
    throw authConflictError('Model', args.modelId);
  }
  if (modelApiKey !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.apiKey' });
    return { apiKey: modelApiKey };
  }
  if (args.model.oauth !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.oauth' });
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
    trace?.record(
      'resolved.auth',
      nonEmpty(args.provider?.apiKey) !== undefined
        ? { kind: 'config', detail: `provider '${args.providerName}' apiKey` }
        : {
            kind: 'env',
            detail: `${providerEndpoint.apiKeyEnvName ?? '?'} (provider '${args.providerName}' env bag)`,
          },
    );
    return { apiKey: providerApiKey };
  }
  if (args.provider?.oauth !== undefined) {
    trace?.record('resolved.auth', {
      kind: 'config',
      detail: `provider '${args.providerName}' oauth`,
    });
    return {
      oauth: args.provider.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }
  trace?.record('resolved.auth', {
    kind: 'none',
    detail: 'no credential resolved at any layer (adapter construction may still read process.env)',
  });
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

function withAnthropicProfile(model: ModelRecord, providerType?: string): ModelRecord {
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
