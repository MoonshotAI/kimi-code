import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { IProtocolAdapterRegistry, Protocol } from '#/kosong/protocol/protocol';

import { getProviderDefinitions } from '../provider/providerDefinition';

import type { ModelThinkingMetadata, ThinkingDefaults } from './model.types';

export interface ThinkingConfig {
  enabled?: boolean;
  effort?: string;
  forcedEffort?: string;
  keep?: string;
}

export function drivesThinkingThroughTraits(providerType: string | undefined): boolean {
  if (providerType === undefined) return false;
  return getProviderDefinitions(providerType).some((definition) =>
    definition.traits.some((trait) => trait.withThinking !== undefined),
  );
}

export function usesTraitDrivenThinking(
  registry: IProtocolAdapterRegistry,
  protocol: Protocol,
  providerType?: string,
): boolean {
  return registry
    .resolveAdapterIdentity(protocol, providerType)
    .traits.some(({ trait }) => trait.withThinking !== undefined);
}

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

export function wireHasProtocolThinkingDisable(protocol: string | undefined): boolean {
  return protocol === 'anthropic' || protocol === 'kimi';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeRequestedThinkingEffort(
  requested: string | undefined,
): ThinkingEffort | undefined {
  return nonEmpty(requested)?.toLowerCase() as ThinkingEffort | undefined;
}

export function resolveForcedThinkingEffort(
  forced: string | undefined,
  effective: ThinkingEffort,
  traitDriven: boolean,
): ThinkingEffort | undefined {
  if (!traitDriven || effective === 'off') return undefined;
  return nonEmpty(forced)?.toLowerCase() as ThinkingEffort | undefined;
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

/**
 * The model's declared `support_efforts`, normalized the same way the
 * resolution layer normalizes them (trimmed, blanks dropped) — for
 * diagnostics that must agree with what resolution accepted.
 */
export function declaredThinkingEfforts(
  model: ModelThinkingMetadata | undefined,
): readonly string[] {
  return effortsFor(model);
}

function declaredDefaultEffortFor(
  model: ModelThinkingMetadata | undefined,
  efforts: readonly string[],
): ThinkingEffort {
  const declaredDefault = nonEmpty(model?.defaultEffort);
  if (declaredDefault !== undefined) {
    const matched = matchDeclaredEffort(efforts, declaredDefault);
    if (matched !== undefined) return matched as ThinkingEffort;
  }
  return middleOf(efforts) as ThinkingEffort;
}

function matchDeclaredEffort(
  efforts: readonly string[],
  effort: string,
): string | undefined {
  return efforts.find((candidate) => candidate.toLowerCase() === effort.toLowerCase());
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
  const efforts = effortsFor(model);
  if (efforts.length > 0) return declaredDefaultEffortFor(model, efforts);
  if (model === undefined || !modelSupportsThinking(model)) return 'off';
  return 'on';
}

export function modelSupportsThinkingEffort(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  strictValidation: boolean,
): boolean {
  if (!strictValidation || effort === 'off') return true;
  const efforts = effortsFor(model);
  if (efforts.length > 0) return effort === 'on' || matchDeclaredEffort(efforts, effort) !== undefined;
  return modelSupportsThinking(model);
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  strictValidation: boolean,
): ThinkingEffort {
  if (effort === 'off' && model?.alwaysThinking !== true) return 'off';
  const efforts = effortsFor(model);
  if (!strictValidation) {
    if (efforts.length === 0) return effort;
    if (effort === 'on') return declaredDefaultEffortFor(model, efforts);
    return (matchDeclaredEffort(efforts, effort) ??
      declaredDefaultEffortFor(model, efforts)) as ThinkingEffort;
  }
  if (efforts.length > 0) {
    if (effort === 'on') return declaredDefaultEffortFor(model, efforts);
    return (matchDeclaredEffort(efforts, effort) ??
      declaredDefaultEffortFor(model, efforts)) as ThinkingEffort;
  }
  if (!modelSupportsThinking(model)) return 'off';
  return 'on';
}

export interface ThinkingEffortFallback {
  readonly configured: ThinkingEffort;
  readonly resolved: ThinkingEffort;
}

export function resolveThinkingEffortForModelWithFallback(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: ModelThinkingMetadata | undefined,
  strictValidation = false,
): { readonly effort: ThinkingEffort; readonly fallback: ThinkingEffortFallback | undefined } {
  const configured = normalizeRequestedThinkingEffort(defaults?.effort);
  const normalized = normalizeRequestedThinkingEffort(requested);
  let effort: ThinkingEffort;
  if (normalized !== undefined) {
    effort = normalized;
  } else if (defaults?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }

  if (effort === 'off' && model?.alwaysThinking === true) {
    effort =
      configured !== undefined && configured !== 'off'
        ? configured
        : defaultThinkingEffortForModel(model);
  }
  const resolved = normalizeThinkingEffortForModel(effort, model, strictValidation);
  const efforts = effortsFor(model);
  const fallback: ThinkingEffortFallback | undefined =
    effort !== 'on' && effort !== 'off' && efforts.length > 0 && matchDeclaredEffort(efforts, effort) === undefined
      ? { configured: effort, resolved }
      : undefined;
  return { effort: resolved, fallback };
}

export function resolveThinkingEffortForModel(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: ModelThinkingMetadata | undefined,
  strictValidation = false,
): ThinkingEffort {
  return resolveThinkingEffortForModelWithFallback(requested, defaults, model, strictValidation)
    .effort;
}

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
