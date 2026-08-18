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

export function resolveThinkingEffortForModel(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: ModelThinkingMetadata | undefined,
  strictValidation = false,
): ThinkingEffort {
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
  return normalizeThinkingEffortForModel(effort, model, strictValidation);
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
