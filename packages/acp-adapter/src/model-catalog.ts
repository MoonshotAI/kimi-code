/**
 * ACP model catalog — adapter-local helper that turns the harness's
 * config snapshot into a flat list of selectable models for the ACP
 * `configOptions` picker (`packages/acp-adapter/src/config-options.ts`).
 *
 * Used to live inside `@moonshot-ai/kimi-code-sdk` as
 * `KimiHarness.listAvailableModels()`; moved here so the SDK keeps a
 * minimal surface and ACP-specific heuristics (thinking-capability
 * derivation, the toggleable-models allow-list) stay scoped to the
 * adapter.
 *
 * Iteration order mirrors `config.models` insertion order — Node's
 * `Object.entries` over plain object keys is insertion-ordered for
 * string keys, matching the Python reference's
 * `for model_key, model in models.items()`.
 *
 * `thinkingSupported` is true if any of:
 *   1. the alias's declared `capabilities` array contains `'thinking'`
 *      (including the capability inferred from the Anthropic wire protocol —
 *      see the `providerType` context below), or
 *   2. the underlying model name matches `/thinking|reason/i`
 *      (always-thinking variants), or
 *   3. the underlying model name is on the {@link TOGGLEABLE_THINKING_MODELS}
 *      allow-list (mirrors `kimi-cli/src/kimi_cli/llm.py:derive_model_capabilities`).
 *
 * The runtime resolves a model's wire protocol from
 * `alias.protocol ?? provider.type` (see
 * `ProviderManager.resolveProviderConfig`). The derive helpers below take the
 * provider's `type` as an optional second argument so the catalog agrees with
 * the runtime about Anthropic profiles even when the alias itself does not
 * declare `protocol`.
 */

import { effectiveModelAlias, type ProviderType } from '@moonshot-ai/agent-core';
import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

/**
 * One catalog row per configured model alias, suitable for an ACP
 * picker. `description` is left optional so the harness can populate it
 * later without breaking callers; ACP UIs treat it as a flavour-text
 * subtitle.
 */
export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly thinkingSupported: boolean;
  /** Declared 'always_thinking' capability — thinking cannot be turned off. */
  readonly alwaysThinking?: boolean;
  /**
   * The model's selectable thinking-effort levels: declared
   * `support_efforts` after override/provider-profile resolution (blank
   * entries dropped, mirroring agent-core's `effortsFor`). Empty for
   * boolean models, where the ACP picker keeps the legacy `off`/`on`
   * pair instead of per-level rows.
   */
  readonly supportEfforts: readonly string[];
  /**
   * The thinking effort to send when the client picks the legacy `'on'`
   * value: the model's declared `default_effort`, else the middle
   * `support_efforts` entry, else `'on'` for boolean models. Mirrors
   * agent-core's `defaultThinkingEffortFor` so the ACP on-state matches
   * the TUI.
   */
  readonly defaultThinkingEffort: string;
}

/**
 * Models that support thinking by toggle (not by name match or
 * `capabilities` declaration). Kept here because the list is
 * ACP-picker-specific UX — moving it into the kernel would bake an
 * adapter concern into a place that doesn't need to know about ACP.
 */
const TOGGLEABLE_THINKING_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

export function deriveThinkingSupported(alias: ModelAlias, providerType?: ProviderType): boolean {
  const effective = effectiveModelAlias(alias, providerType);
  const declared = effective.capabilities ?? [];
  if (declared.includes('thinking') || declared.includes('always_thinking')) return true;
  const lower = effective.model.toLowerCase();
  if (lower.includes('thinking') || lower.includes('reason')) return true;
  if (TOGGLEABLE_THINKING_MODELS.has(effective.model)) return true;
  return false;
}

/**
 * Whether the alias declares the 'always_thinking' capability — the model
 * cannot run with thinking disabled, so the ACP toggle must lock to on.
 * Deliberately capability-only: the name heuristics above keep feeding
 * `thinkingSupported`, but only an explicit (server-derived) declaration
 * may remove the off option from the client.
 */
export function deriveAlwaysThinking(alias: ModelAlias, providerType?: ProviderType): boolean {
  return (effectiveModelAlias(alias, providerType).capabilities ?? []).includes(
    'always_thinking',
  );
}

/**
 * The model's selectable thinking-effort levels: declared
 * `support_efforts` (after override/provider-profile resolution) with
 * blank entries dropped — mirrors agent-core's `effortsFor`. Empty for
 * boolean models (thinking support without `support_efforts`).
 */
export function deriveSupportEfforts(
  alias: ModelAlias,
  providerType?: ProviderType,
): readonly string[] {
  return (effectiveModelAlias(alias, providerType).supportEfforts ?? []).filter(
    (effort) => effort.length > 0,
  );
}

/**
 * The effort a boolean "thinking on" toggle maps to for this model: declared
 * `default_effort`, else the middle `support_efforts` entry, else `'on'` for
 * boolean models (no `support_efforts`).
 */
export function deriveDefaultThinkingEffort(
  alias: ModelAlias,
  providerType?: ProviderType,
): string {
  const effective = effectiveModelAlias(alias, providerType);
  const efforts = effective.supportEfforts;
  if (efforts !== undefined && efforts.length > 0) {
    return effective.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

/**
 * Project `harness.getConfig().models` into a flat catalog. Returns an
 * empty array when the harness has no models configured, when
 * `getConfig` is missing on the harness (partial test stubs), or when
 * `getConfig` throws — letting the caller decide how to surface a
 * degenerate config without forcing every test stub to provide every
 * field.
 */
export async function listModelsFromHarness(
  harness: KimiHarness,
): Promise<readonly AcpModelEntry[]> {
  if (typeof harness.getConfig !== 'function') return [];
  let config: Awaited<ReturnType<KimiHarness['getConfig']>>;
  try {
    config = await harness.getConfig();
  } catch {
    return [];
  }
  const models = config.models;
  if (models === undefined) return [];
  const out: AcpModelEntry[] = [];
  for (const [id, alias] of Object.entries(models)) {
    const providerType = providerTypeOf(alias, config);
    const effective = effectiveModelAlias(alias, providerType);
    out.push({
      id,
      name: effective.displayName ?? effective.model ?? id,
      thinkingSupported: deriveThinkingSupported(alias, providerType),
      alwaysThinking: deriveAlwaysThinking(alias, providerType),
      supportEfforts: deriveSupportEfforts(alias, providerType),
      defaultThinkingEffort: deriveDefaultThinkingEffort(alias, providerType),
    });
  }
  return out;
}

/**
 * The alias's provider type, resolved like
 * `ProviderManager.resolveProviderConfig` does: the alias's provider (falling
 * back to the configured default provider). The Anthropic fallback profile in
 * `effectiveModelAlias` only applies to non-Kimi providers, and then only to
 * model names that still carry a Claude marker — a custom-named Claude model
 * on a `type = "anthropic"` provider still gets an inferred effort list,
 * while managed Kimi models and clearly non-Claude names keep only their
 * catalog-declared efforts.
 */
function providerTypeOf(
  alias: ModelAlias,
  config: {
    providers?: Record<string, { type?: ProviderType } | undefined>;
    defaultProvider?: string | undefined;
  },
): ProviderType | undefined {
  const providerName = alias.provider ?? config.defaultProvider;
  const providerType =
    providerName === undefined ? undefined : config.providers?.[providerName]?.type;
  // Flat models (inline base_url, no named provider) have no provider entry to
  // look up; their own protocol declaration plays the provider-identity role,
  // mirroring the v2 ModelCatalog.
  return providerType ?? alias.protocol;
}
