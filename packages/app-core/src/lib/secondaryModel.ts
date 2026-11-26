import type { AppConfig, SecondaryModelEntry } from '../api/types';

export type SecondaryModelConfig = NonNullable<AppConfig['secondaryModel']>;

export type SecondaryModelMode = 'follow' | 'fixed' | 'auto';
export type SecondaryModelAutoScope = 'all' | 'selected';
export type SecondaryModelRulePreset = 'cost' | 'speed' | 'custom';

export interface NormalizedSecondaryModelEntry {
  readonly description: string;
  readonly effort: string;
}

export function resolveSecondaryModelMode(
  config: AppConfig['secondaryModel'],
): SecondaryModelMode {
  if (!config) return 'follow';
  if (
    config.allModels === true ||
    config.models !== undefined ||
    (config.rule !== undefined && config.rule.trim().length > 0)
  ) {
    return 'auto';
  }
  if (config.defaultModel !== undefined || config.model !== undefined) {
    return 'fixed';
  }
  return 'follow';
}

export function resolveSecondaryModelAutoScope(
  config: AppConfig['secondaryModel'],
): SecondaryModelAutoScope {
  return config?.allModels === true ? 'all' : 'selected';
}

export function readSecondaryModelEntry(
  entry: SecondaryModelEntry | undefined,
): NormalizedSecondaryModelEntry {
  if (typeof entry === 'string') return { description: entry, effort: '' };
  if (entry !== undefined) {
    return {
      description: entry.description ?? '',
      effort: entry.effort ?? '',
    };
  }
  return { description: '', effort: '' };
}

export function serializeSecondaryModelEntry(entry: {
  description?: string;
  effort?: string;
}): SecondaryModelEntry {
  const description = entry.description ?? '';
  const effort = entry.effort ?? '';
  if (!effort) return description;
  return description.length > 0 ? { description, effort } : { effort };
}

export function buildFixedSecondaryModelConfig(choice: {
  model: string;
  effort?: string;
}): SecondaryModelConfig {
  const config: SecondaryModelConfig = { defaultModel: choice.model };
  if (choice.effort) config.defaultEffort = choice.effort;
  return config;
}

export function buildAllModelsSecondaryConfig(rule?: string): SecondaryModelConfig {
  const config: SecondaryModelConfig = { allModels: true };
  const trimmed = rule?.trim();
  if (trimmed) config.rule = trimmed;
  return config;
}

export function buildSelectedModelsSecondaryConfig(input: {
  defaultModel?: string;
  entries: Readonly<Record<string, { description?: string; effort?: string }>>;
  rule?: string;
}): SecondaryModelConfig | null {
  const aliases = Object.keys(input.entries);
  if (aliases.length === 0) return null;
  const defaultModel =
    input.defaultModel !== undefined && Object.hasOwn(input.entries, input.defaultModel)
      ? input.defaultModel
      : aliases[0]!;
  const models: Record<string, SecondaryModelEntry> = {};
  for (const alias of aliases) {
    models[alias] = serializeSecondaryModelEntry(input.entries[alias]!);
  }
  const config: SecondaryModelConfig = { defaultModel, models };
  const trimmed = input.rule?.trim();
  if (trimmed) config.rule = trimmed;
  return config;
}

export function buildSecondaryModelPatch(
  current: AppConfig['secondaryModel'],
  choice: { model: string; effort?: string },
): SecondaryModelConfig {
  const patch: SecondaryModelConfig = { defaultModel: choice.model };
  if (current?.models !== undefined && !Object.hasOwn(current.models, choice.model)) {
    patch.models = { ...current.models, [choice.model]: '' };
  }
  if (choice.effort) patch.defaultEffort = choice.effort;
  return patch;
}
