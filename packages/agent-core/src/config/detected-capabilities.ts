import { getProviderModelCapability } from '@moonshot-ai/kosong';

import type { KimiConfig, KimiConfigPatch, ModelAlias, ProviderType } from './schema';

/**
 * Capability strings contributed by kosong's built-in model knowledge for a
 * (provider wire type, model) pair. `always_thinking` implies `thinking`, and
 * both are spelled out so consumers can keep checking for plain `'thinking'`
 * membership.
 */
function detectedCapabilityStrings(
  providerType: ProviderType | undefined,
  model: string | undefined,
): readonly string[] {
  if (providerType === undefined || model === undefined) return [];
  const detected = getProviderModelCapability(providerType, model);
  return detected.always_thinking === true ? ['thinking', 'always_thinking'] : [];
}

function normalize(capability: string): string {
  return capability.trim().toLowerCase();
}

function hasCapability(declared: readonly string[], capability: string): boolean {
  return declared.some((c) => normalize(c) === capability);
}

/**
 * Enrich runtime model aliases with capabilities detected from kosong's
 * built-in model knowledge (e.g. `claude-fable-5`, whose thinking cannot be
 * turned off), so UIs reading `models.<alias>.capabilities` see them without
 * the user declaring them by hand.
 *
 * Runtime-only, same contract as the env-synthesized model in
 * `loadRuntimeConfig`: write-back paths re-read the config file from disk and
 * `stripDetectedModelCapabilities` removes these from incoming patches, so
 * detected capabilities are never persisted. Catalog-declared models get the
 * same capabilities written into their alias at `provider catalog add` time
 * instead (see `always_reasoning` in the kosong catalog schema).
 */
export function applyDetectedModelCapabilities(config: KimiConfig): KimiConfig {
  const models = config.models;
  if (models === undefined) return config;

  let changed = false;
  const enriched: Record<string, ModelAlias> = {};
  for (const [alias, model] of Object.entries(models)) {
    const declared = model.capabilities ?? [];
    const missing = detectedCapabilityStrings(
      config.providers[model.provider]?.type,
      model.model,
    ).filter((capability) => !hasCapability(declared, capability));
    if (missing.length === 0) {
      enriched[alias] = model;
      continue;
    }
    enriched[alias] = { ...model, capabilities: [...declared, ...missing] };
    changed = true;
  }
  return changed ? { ...config, models: enriched } : config;
}

/**
 * Remove detected-only capabilities from a config patch before it is merged
 * into the on-disk config.
 *
 * Callers commonly write back models obtained from `getConfig()`, whose
 * aliases were enriched by {@link applyDetectedModelCapabilities}. Persisting
 * those would turn runtime detection into a user declaration that outlives
 * (and, capabilities being additive, overrides) future corrections to the
 * detection knowledge. A capability is stripped only when the on-disk config
 * does not declare it AND detection would re-add it at load time — anything
 * the user (or the catalog) actually declared is preserved verbatim.
 */
export function stripDetectedModelCapabilities(
  patch: KimiConfigPatch,
  diskConfig: KimiConfig,
): KimiConfigPatch {
  const models = patch.models;
  if (models === undefined) return patch;

  let changed = false;
  const stripped: NonNullable<KimiConfigPatch['models']> = {};
  for (const [alias, model] of Object.entries(models)) {
    const capabilities = model?.capabilities;
    if (model === undefined || capabilities === undefined || capabilities.length === 0) {
      stripped[alias] = model;
      continue;
    }
    const onDisk = diskConfig.models?.[alias];
    const providerId = model.provider ?? onDisk?.provider;
    const providerType =
      providerId === undefined
        ? undefined
        : (patch.providers?.[providerId]?.type ?? diskConfig.providers[providerId]?.type);
    const detected = detectedCapabilityStrings(providerType, model.model ?? onDisk?.model);
    const declaredOnDisk = onDisk?.capabilities ?? [];
    const kept = capabilities.filter((c) => {
      const capability = normalize(c);
      return !detected.includes(capability) || hasCapability(declaredOnDisk, capability);
    });
    if (kept.length === capabilities.length) {
      stripped[alias] = model;
      continue;
    }
    stripped[alias] = { ...model, capabilities: kept.length > 0 ? kept : undefined };
    changed = true;
  }
  return changed ? { ...patch, models: stripped } : patch;
}
