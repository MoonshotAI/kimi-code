import { z } from 'zod';

import {
  type ConfigStripEnv,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  snakeToCamel,
  transformPlainObject,
} from '#/app/config/toml';
import { type AssertExact, type Equal } from '#/_base/utils/typeEquality';
import type { ModelOverride, ModelRecord, ModelsSection } from '#/kosong/model/model';
import type { ThinkingConfig } from '#/kosong/model/thinking';
import type { OAuthRef, ProviderConfig, ProvidersSection } from '#/kosong/provider/provider';
import { ProtocolSchema } from '#/kosong/protocol/protocol';

export const PROVIDERS_SECTION = 'providers';

export const DEFAULT_PROVIDER_SECTION = 'defaultProvider';

export const ENV_MODEL_PROVIDER_KEY = '__kimi_env__';

export const ProviderTypeSchema = z.string();

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export const ModelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);

const StringRecordSchema = z.record(z.string(), z.string());

export const ProviderConfigSchema = z.object({
  modelSource: ModelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  proxyUrl: z.string().optional(),
  customHeaders: StringRecordSchema.optional(),
  defaultModel: z.string().optional(),

  type: ProviderTypeSchema.optional(),
  apiKey: z.string().optional(),
  apiKeys: z.record(z.string(), z.object({ key: z.string(), name: z.string() })).optional(),
  activeApiKeyId: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  free_models_only: z.boolean().optional(),
});

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

type _AssertOAuthRef = AssertExact<Equal<z.infer<typeof OAuthRefSchema>, OAuthRef>>;
type _AssertProviderConfig = AssertExact<
  Equal<z.infer<typeof ProviderConfigSchema>, ProviderConfig>
>;
type _AssertProvidersSection = AssertExact<
  Equal<z.infer<typeof ProvidersSectionSchema>, ProvidersSection>
>;

export const providersEnvBindings = envBindings(ProvidersSectionSchema, {
  [ENV_MODEL_PROVIDER_KEY]: envBindings(ProviderConfigSchema, {
    apiKey: 'KIMI_MODEL_API_KEY',
    type: 'KIMI_MODEL_PROVIDER_TYPE',
    baseUrl: 'KIMI_MODEL_BASE_URL',
  }),
});

export const stripProvidersEnv: ConfigStripEnv<Record<string, unknown>> = (value) => {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (!(ENV_MODEL_PROVIDER_KEY in value)) return value;
  const out = { ...value };
  delete out[ENV_MODEL_PROVIDER_KEY];
  return out;
};

export const providersFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawSnake)) {
    out[name] = isPlainObject(entry) ? providerEntryFromToml(entry) : entry;
  }
  return out;
};

function providerEntryFromToml(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = isPlainObject(value) ? cloneRecord(value) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

export const providersToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    out[name] = isPlainObject(entry) ? providerEntryToToml(entry, rawSub[name]) : entry;
  }
  return out;
};

function providerEntryToToml(
  provider: Record<string, unknown>,
  rawProvider: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawProvider);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = plainObjectToToml(value, undefined);
    } else if ((key === 'env' || key === 'customHeaders') && value !== undefined) {
      out[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

registerConfigSection(PROVIDERS_SECTION, ProvidersSectionSchema, {
  defaultValue: {},
  env: providersEnvBindings,
  stripEnv: stripProvidersEnv,
  fromToml: providersFromToml,
  toToml: providersToToml,
});

export const MODELS_SECTION = 'models';

export const DEFAULT_MODEL_SECTION = 'defaultModel';

const ModelBaseSchema = z.object({
  providerId: z.string().optional(),

  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),

  protocol: ProtocolSchema.optional(),

  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),

  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});

export const ModelOverrideSchema = ModelBaseSchema.omit({
  providerId: true,
  baseUrl: true,
  apiKey: true,
  oauth: true,
  protocol: true,
  name: true,
  aliases: true,
  provider: true,
  model: true,
  betaApi: true,
}).partial();

export const ModelRecordSchema = ModelBaseSchema.extend({
  overrides: ModelOverrideSchema.optional(),
}).passthrough();

export const ModelsSectionSchema = z.record(z.string(), ModelRecordSchema);

type _AssertModelOverride = AssertExact<
  Equal<z.infer<typeof ModelOverrideSchema>, ModelOverride>
>;
type _AssertModelRecord = AssertExact<Equal<z.infer<typeof ModelRecordSchema>, ModelRecord>>;
type _AssertModelsSection = AssertExact<
  Equal<z.infer<typeof ModelsSectionSchema>, ModelsSection>
>;

export const modelsFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(rawSnake)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const converted = transformPlainObject(entry);
    if (isPlainObject(converted['overrides'])) {
      converted['overrides'] = transformPlainObject(converted['overrides']);
    }
    out[id] = converted;
  }
  return out;
};

export const modelsToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const merged = cloneRecord(rawSub[id]);
    for (const [key, field] of Object.entries(entry)) {
      if (key === 'capabilities' && Array.isArray(field)) {
        merged[camelToSnake(key)] = [...field];
      } else if (key === 'overrides' && isPlainObject(field)) {
        merged['overrides'] = modelOverridesToToml(field, merged['overrides']);
      } else {
        setDefined(merged, camelToSnake(key), field);
      }
    }
    out[id] = merged;
  }
  return out;
};

function modelOverridesToToml(
  overrides: Record<string, unknown>,
  rawSnake: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawSnake);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

registerConfigSection(MODELS_SECTION, ModelsSectionSchema, {
  defaultValue: {},
  fromToml: modelsFromToml,
  toToml: modelsToToml,
});

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  forcedEffort: z.string().optional(),
  keep: z.string().optional(),
});

type _AssertThinkingConfig = AssertExact<
  Equal<z.infer<typeof ThinkingConfigSchema>, ThinkingConfig>
>;

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

export const SECONDARY_MODEL_SECTION = 'secondaryModel';

export const SECONDARY_MODEL_ENV = 'KIMI_SECONDARY_MODEL';
export const SECONDARY_MODEL_EFFORT_ENV = 'KIMI_SECONDARY_EFFORT';

export const SecondaryModelConfigSchema = ModelOverrideSchema.extend({
  model: z.string().min(1).optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

function parseNonEmptyEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const secondaryModelEnvBindings = envBindings(SecondaryModelConfigSchema, {
  model: { env: SECONDARY_MODEL_ENV, parse: parseNonEmptyEnv },
  defaultEffort: { env: SECONDARY_MODEL_EFFORT_ENV, parse: parseNonEmptyEnv },
});

export const VISUAL_MODEL_SECTION = 'visualModel';

export const VISUAL_MODEL_ENV = 'KIMI_VISUAL_MODEL';
export const VISUAL_MODEL_EFFORT_ENV = 'KIMI_VISUAL_EFFORT';

export const VisualModelConfigSchema = ModelOverrideSchema.extend({
  model: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
});

export type VisualModelConfig = z.infer<typeof VisualModelConfigSchema>;

export const visualModelEnvBindings = envBindings(VisualModelConfigSchema, {
  model: { env: VISUAL_MODEL_ENV, parse: parseNonEmptyEnv },
  defaultEffort: { env: VISUAL_MODEL_EFFORT_ENV, parse: parseNonEmptyEnv },
});

registerConfigSection(VISUAL_MODEL_SECTION, VisualModelConfigSchema, {
  env: visualModelEnvBindings,
  stripEnv: stripEnvBoundFields(visualModelEnvBindings),
});

export const COMPACTION_MODEL_SECTION = 'compactionModel';

export const COMPACTION_MODEL_ENV = 'KIMI_COMPACTION_MODEL';
export const COMPACTION_MODEL_EFFORT_ENV = 'KIMI_COMPACTION_EFFORT';

export const CompactionModelConfigSchema = ModelOverrideSchema.extend({
  model: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  secondaryModel: z.string().min(1).optional(),
});

export type CompactionModelConfig = z.infer<typeof CompactionModelConfigSchema>;

export const compactionModelEnvBindings = envBindings(CompactionModelConfigSchema, {
  model: { env: COMPACTION_MODEL_ENV, parse: parseNonEmptyEnv },
  defaultEffort: { env: COMPACTION_MODEL_EFFORT_ENV, parse: parseNonEmptyEnv },
});

registerConfigSection(COMPACTION_MODEL_SECTION, CompactionModelConfigSchema, {
  env: compactionModelEnvBindings,
  stripEnv: stripEnvBoundFields(compactionModelEnvBindings),
});

export const FALLBACK_MODEL_SECTION = 'fallbackModel';

export const FALLBACK_MODEL_ENV = 'KIMI_FALLBACK_MODEL';
export const FALLBACK_SECONDARY_MODEL_ENV = 'KIMI_FALLBACK_SECONDARY_MODEL';

export const FallbackModelConfigSchema = ModelOverrideSchema.extend({
  model: z.string().min(1).optional(),
  secondaryModel: z.string().min(1).optional(),
});

export type FallbackModelConfig = z.infer<typeof FallbackModelConfigSchema>;

export const fallbackModelEnvBindings = envBindings(FallbackModelConfigSchema, {
  model: { env: FALLBACK_MODEL_ENV, parse: parseNonEmptyEnv },
  secondaryModel: { env: FALLBACK_SECONDARY_MODEL_ENV, parse: parseNonEmptyEnv },
});

registerConfigSection(FALLBACK_MODEL_SECTION, FallbackModelConfigSchema, {
  env: fallbackModelEnvBindings,
  stripEnv: stripEnvBoundFields(fallbackModelEnvBindings),
});

export const MODEL_CATALOG_SECTION = 'modelCatalog';

export const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

registerConfigSection(MODEL_CATALOG_SECTION, ModelCatalogConfigSchema);
