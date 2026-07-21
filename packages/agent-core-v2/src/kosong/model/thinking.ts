/**
 * `kosong/model` domain (L2) — the single authority on thinking semantics.
 *
 * Three kinds of knowledge live here, and nowhere else:
 *
 *  1. The `thinking` config section (`[thinking]`: enabled / effort / keep,
 *     plus the env-only `KIMI_MODEL_THINKING_EFFORT` force override). The
 *     section self-registers at module load — a side effect; production gets
 *     it from the `src/index.ts` side-effect block and tests import this
 *     module on demand. This module is the sole owner of the section — the
 *     legacy `agent/profile/configSection` is gone.
 *  2. Effort/keep resolution: pure helpers that fold a requested effort, the
 *     config defaults, and the model's declared thinking metadata into the
 *     effective `ThinkingEffort`, and that resolve the thinking-keep value.
 *  3. The registry-driven vendor verdicts: `drivesThinkingThroughTraits`
 *     (definition lookup: the vendor's traits take over thinking encoding)
 *     and `usesTraitDrivenThinking` (the resolved adapter identity for the
 *     (protocol, providerType) pair contains a `withThinking` hook). Neither
 *     hardcodes a vendor or protocol string — trait-driven thinking means
 *     "thinking is driven by traits", which the registry answers.
 */

import { z } from 'zod';

import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { IProtocolAdapterRegistry, Protocol } from '#/kosong/protocol/protocol';

import { type ConfigStripEnv, envBindings } from '../../app/config/config';
import { registerConfigSection } from '../../app/config/configSectionContributions';
import { getProviderDefinitions } from '../provider/providerDefinition';

import type { ModelThinkingMetadata, ThinkingDefaults } from './model.types';

// ---------------------------------------------------------------------------
// `thinking` config section (side-effect registration)
// ---------------------------------------------------------------------------

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  forcedEffort: z.string().optional(),
  keep: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

export const thinkingEnvBindings = envBindings(ThinkingConfigSchema, {
  forcedEffort: 'KIMI_MODEL_THINKING_EFFORT',
});

export const stripThinkingEnv: ConfigStripEnv<ThinkingConfig> = (value) => {
  const result = { ...value };
  delete result.forcedEffort;
  return result;
};

registerConfigSection(THINKING_SECTION, ThinkingConfigSchema, {
  env: thinkingEnvBindings,
  stripEnv: stripThinkingEnv,
});

// ---------------------------------------------------------------------------
// Registry-driven vendor verdicts
// ---------------------------------------------------------------------------

/**
 * Whether the vendor drives thinking through its traits: a definition-lookup
 * answer — the vendor is registered and at least one of its registrations
 * declares `withThinking`. Unregistered vendors (fully compatible, no
 * definition) answer `false`.
 */
export function drivesThinkingThroughTraits(providerType: string | undefined): boolean {
  if (providerType === undefined) return false;
  return getProviderDefinitions(providerType).some((definition) =>
    definition.traits.some((trait) => trait.withThinking !== undefined),
  );
}

/**
 * Whether the (protocol, providerType) pair resolves to an adapter whose
 * traits take over thinking encoding — via the vendor's registration on its
 * native transport, or via its pair registration on a foreign one. Answered
 * through the registry's one resolution point, `resolveAdapterIdentity`.
 */
export function usesTraitDrivenThinking(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  return registry
    .resolveAdapterIdentity(protocol, providerType)
    .traits.some(({ trait }) => trait.withThinking !== undefined);
}

/**
 * ⚠ PHASE 6 PARITY PATCH — v1 `provider.type === 'kimi'` gate restored.
 *
 * Whether client-side thinking-effort validation must be STRICT for the
 * (protocol, providerType) pair: the resolved traits take thinking over and
 * the last `withThinking` declarer marks `strictThinkingValidation`.
 *
 * This is the gate for client-side effort strictness (validation, the
 * always-on clamp, and the `'on'` projection). The strict flag is declared
 * by `kimiOpenAITrait` — Kimi's native API rejects unlisted efforts — and
 * deliberately NOT by `kimiAnthropicTrait`: over the Anthropic
 * transport the backend may accept efforts the local catalog metadata does
 * not list, so the profile must stay lenient there (warn-and-send, with the
 * `anthropic-thinking-*` warnings) instead of rejecting or rewriting the
 * effort. Gating on plain `usesTraitDrivenThinking` (true for the
 * anthropic pair registration too) made `setThinking` throw for Kimi-managed
 * Anthropic models and left the warning path unreachable — a v1 behavioral
 * regression.
 */
export function requiresStrictThinkingValidation(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  if (providerType === undefined) return false;
  const traits = registry.resolveAdapterIdentity(protocol, providerType).traits;
  let strict = false;
  for (const { trait } of traits) {
    if (trait.withThinking !== undefined) {
      strict = trait.strictThinkingValidation === true;
    }
  }
  return strict;
}

// ---------------------------------------------------------------------------
// Effort resolution (pure)
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeRequestedThinkingEffort(
  requested: string | undefined,
): ThinkingEffort | undefined {
  return nonEmpty(requested)?.toLowerCase() as ThinkingEffort | undefined;
}

/**
 * The `KIMI_MODEL_THINKING_EFFORT` operational override: applies only when
 * the vendor drives thinking through traits and the effective effort is not
 * `'off'`.
 */
export function resolveForcedThinkingEffort(
  forced: string | undefined,
  effective: ThinkingEffort,
  traitDriven: boolean,
): ThinkingEffort | undefined {
  if (!traitDriven || effective === 'off') return undefined;
  return nonEmpty(forced) as ThinkingEffort | undefined;
}

function hasCapability(
  capabilities: ModelThinkingMetadata['capabilities'],
  capability: string,
): boolean {
  if (capabilities === undefined) return false;
  if (isCapabilityList(capabilities)) {
    return capabilities.some((candidate) => candidate.trim().toLowerCase() === capability);
  }
  switch (capability) {
    case 'thinking':
      return capabilities.thinking;
    case 'always_thinking':
      return false;
    default:
      return false;
  }
}

function isCapabilityList(
  capabilities: ModelThinkingMetadata['capabilities'],
): capabilities is readonly string[] {
  return Array.isArray(capabilities);
}

function middleOf(values: readonly string[]): string {
  return values[Math.floor(values.length / 2)]!;
}

function effortsFor(model: ModelThinkingMetadata | undefined): readonly string[] {
  return model?.supportEfforts?.map(nonEmpty).filter((v): v is string => v !== undefined) ?? [];
}

export function modelSupportsThinking(model: ModelThinkingMetadata | undefined): boolean {
  if (model === undefined) return false;
  return (
    model.alwaysThinking === true ||
    model.adaptiveThinking === true ||
    hasCapability(model.capabilities, 'thinking') ||
    hasCapability(model.capabilities, 'always_thinking')
  );
}

export function defaultThinkingEffortForModel(
  model: ModelThinkingMetadata | undefined,
): ThinkingEffort {
  if (model === undefined || !modelSupportsThinking(model)) return 'off';
  const efforts = effortsFor(model);
  if (efforts.length > 0) {
    const declaredDefault = nonEmpty(model.defaultEffort);
    return (declaredDefault !== undefined && efforts.includes(declaredDefault)
      ? declaredDefault
      : middleOf(efforts)) as ThinkingEffort;
  }
  return 'on';
}

export function modelSupportsThinkingEffort(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  strictValidation: boolean,
): boolean {
  if (!strictValidation || effort === 'off') return true;
  if (!modelSupportsThinking(model)) return false;
  const efforts = effortsFor(model);
  return efforts.length === 0 || effort === 'on' || efforts.includes(effort);
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  strictValidation: boolean,
): ThinkingEffort {
  if (effort === 'off' && model?.alwaysThinking !== true) return 'off';
  const efforts = effortsFor(model);
  if (!strictValidation) {
    return effort === 'on' && efforts.length > 0
      ? defaultThinkingEffortForModel(model)
      : effort;
  }
  if (!modelSupportsThinking(model)) return 'off';
  if (efforts.length === 0) return 'on';
  if (effort === 'on' || !efforts.includes(effort)) {
    return defaultThinkingEffortForModel(model);
  }
  return effort;
}

/**
 * Resolve the effective thinking effort from a requested effort, the
 * `thinking` config defaults, and the model's declared thinking metadata.
 * `strictValidation` is the registry-driven strict-validation verdict for
 * the model's (protocol, providerType) pair.
 */
export function resolveThinkingEffortForModel(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: ModelThinkingMetadata | undefined,
  strictValidation = false,
): ThinkingEffort {
  const configured = nonEmpty(defaults?.effort) as ThinkingEffort | undefined;
  const normalized = normalizeRequestedThinkingEffort(requested);
  let effort: ThinkingEffort;
  if (normalized !== undefined) {
    effort = normalized;
  } else if (defaults?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }

  if (strictValidation && effort === 'off' && model?.alwaysThinking === true) {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }
  return normalizeThinkingEffortForModel(effort, model, strictValidation);
}

// ---------------------------------------------------------------------------
// Keep resolution (pure)
// ---------------------------------------------------------------------------

const KEEP_OFF_VALUES = new Set(['0', 'false', 'no', 'off', 'none', 'null']);

type KeepResolution =
  | { readonly specified: false }
  | { readonly specified: true; readonly value: string | undefined };

function parseKeepValue(raw: string | undefined): KeepResolution {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { specified: false };
  if (KEEP_OFF_VALUES.has(trimmed.toLowerCase())) return { specified: true, value: undefined };
  return { specified: true, value: trimmed };
}

/**
 * Resolve the thinking-keep value from the env override (`modelOverrides`'s
 * `thinkingKeep`, sourced from `KIMI_MODEL_THINKING_KEEP`), the `thinking`
 * config `keep`, and the effective effort. Off-values (`0`/`false`/`no`/
 * `off`/`none`/`null`) explicitly disable keep; thinking `'off'` never keeps.
 */
export function resolveThinkingKeep(
  envKeep: string | undefined,
  configKeep: string | undefined,
  thinkingEffort: ThinkingEffort,
): string | undefined {
  if (thinkingEffort === 'off') return undefined;
  const fromEnv = parseKeepValue(envKeep);
  if (fromEnv.specified) return fromEnv.value;
  const fromConfig = parseKeepValue(configKeep);
  if (fromConfig.specified) return fromConfig.value;
  return 'all';
}
