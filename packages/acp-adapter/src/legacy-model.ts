/**
 * Local copy of `effectiveModelAlias` from the retired TS engine package
 * `@moonshot-ai/agent-core` (v1) — `packages/agent-core/src/config/model.ts`.
 *
 * The adapter's model catalog uses it to resolve a model alias's effective
 * shape (overrides applied, input cap clamped, Anthropic profile inferred).
 * The engine package is being retired, so the function is ported here. Its
 * profile helpers come from `@moonshot-ai/kosong` (a live package), which the
 * v1 implementation itself imported.
 *
 * The `ModelAlias` type is imported from `@moonshot-ai/kimi-code-sdk`, which
 * re-exported the engine's `ModelAlias` — the shapes are identical.
 */

import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '@moonshot-ai/kosong/providers/anthropic-profile';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import type { ProviderType } from './legacy-types.js';

export function effectiveModelAlias(alias: ModelAlias, providerType?: ProviderType): ModelAlias {
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

  // The input cap can never exceed the effective total window (an override
  // lowering max_context_size must not leave a stale, larger cap behind).
  // Build a copy for the clamp — never rewrite the caller's config record.
  const clamped =
    effective.maxInputSize !== undefined && effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;

  return withAnthropicProfile(clamped, providerType);
}

function withAnthropicProfile(model: ModelAlias, providerType?: ProviderType): ModelAlias {
  const protocol = model.protocol ?? providerType;
  // The inferred fallback profile exists for third-party Anthropic-compatible
  // endpoints whose model name encodes no known Claude version. It only
  // applies to names that still carry a Claude marker (e.g. a proxied
  // `claude-latest`): clearly non-Claude models served over the Anthropic
  // protocol (catalog-imported Kimi `k3`, GLM, …) must not advertise Claude
  // effort levels. Kimi providers — including managed models routed through
  // protocol = "anthropic" — declare thinking efforts via the catalog, so
  // they never receive the fallback. Callers without provider context fall
  // back to name matching only.
  const profile =
    providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
      ? (matchKnownAnthropicModelProfile(model.model) ?? matchUnknownClaudeProfile(model.model))
      : matchKnownAnthropicModelProfile(model.model);
  if (profile === undefined) {
    // A non-Claude model on the Anthropic protocol normally gets no inferred
    // efforts — but an explicit `adaptive_thinking = false` is a positive
    // declaration that the endpoint speaks budget thinking (e.g. GLM /
    // DeepSeek behind an Anthropic-compatible gateway), so advertise the
    // budget effort levels.
    if (protocol === 'anthropic' && model.adaptiveThinking === false) {
      const capabilities = model.capabilities ?? [];
      const hasThinking = capabilities.some(
        (candidate) => candidate.trim().toLowerCase() === 'thinking',
      );
      const supportEfforts = model.supportEfforts ?? [...BUDGET_THINKING_EFFORTS];
      return {
        ...model,
        capabilities: hasThinking ? capabilities : [...capabilities, 'thinking'],
        supportEfforts,
        defaultEffort:
          model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
      };
    }
    return model;
  }

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
    defaultEffort: model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
  };
}
