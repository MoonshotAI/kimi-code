import { z } from 'zod';

import { deepMerge, isPlainObject } from './pure';
import type { ConfigDiagnostic, ConfigSectionContribution } from './store';
import {
  camelToSnake,
  cloneRecord,
  plainObjectToToml,
  setDefined,
  snakeToCamel,
  transformPlainObject,
} from './toml';

export const PROVIDERS_CONFIG_SECTION = 'providers';

export const MODELS_CONFIG_SECTION = 'models';

export const THINKING_CONFIG_SECTION = 'thinking';

export const MODEL_CATALOG_CONFIG_SECTION = 'modelCatalog';

export const DEFAULT_MODEL_CONFIG_SECTION = 'defaultModel';

export const ENV_MODEL_PROVIDER_KEY = '__kimi_env__';

const StringRecordSchema = z.record(z.string(), z.string());

const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const CatalogOAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export const ModelCapabilitySchema = z.object({
  image_in: z.boolean(),
  video_in: z.boolean(),
  audio_in: z.boolean(),
  thinking: z.boolean(),
  tool_use: z.boolean(),
  dynamically_loaded_tools: z.boolean().optional(),
});

export const CatalogProviderInfoSchema = z.object({
  type: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  customHeaders: StringRecordSchema.optional(),
  defaultModel: z.string().optional(),
  oauth: CatalogOAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  modelSource: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  source: UnknownRecordSchema.optional(),
  aliasScope: z.string().optional(),
});

export const ProvidersSectionSchema = z.record(z.string(), CatalogProviderInfoSchema);

export type ProvidersSection = z.infer<typeof ProvidersSectionSchema>;

export const CatalogModelOverridesSchema = z.object({
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capability: ModelCapabilitySchema.optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
  alwaysThinking: z.boolean().optional(),
});

export const CatalogModelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  capability: ModelCapabilitySchema.optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultHeaders: StringRecordSchema.optional(),
  displayName: z.string().optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  reasoningKey: z.string().optional(),
  supportEfforts: z.array(z.string()).optional(),
  offEffort: z.string().optional(),
  alwaysThinking: z.boolean().optional(),
  protocol: z.string().optional(),
  defaultEffort: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  vertexai: z.boolean().optional(),
  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  oauth: CatalogOAuthRefSchema.optional(),
  overrides: CatalogModelOverridesSchema.optional(),
  extras: UnknownRecordSchema.optional(),
});

export const ModelsSectionSchema = z.record(z.string(), CatalogModelConfigSchema);

export type ModelsSection = z.infer<typeof ModelsSectionSchema>;

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  forcedEffort: z.string().optional(),
  keep: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

export const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

const providersFromToml = (raw: unknown): unknown => {
  if (!isPlainObject(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
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
    } else if (targetKey === 'env' || targetKey === 'customHeaders' || targetKey === 'source') {
      out[targetKey] = isPlainObject(value) ? cloneRecord(value) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

const providersToToml = (value: unknown, raw: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(raw);
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
    } else if ((key === 'env' || key === 'customHeaders' || key === 'source') && value !== undefined) {
      out[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

const REQUIRED_CAPABILITY_KEYS = ['image_in', 'video_in', 'audio_in', 'thinking', 'tool_use'] as const;

const CAPABILITY_KEYS = [...REQUIRED_CAPABILITY_KEYS, 'dynamically_loaded_tools'] as const;

const CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(CAPABILITY_KEYS);

export function capabilityFromArray(
  value: readonly unknown[],
): { capability: Record<string, unknown>; unknowns: unknown[] } {
  const capability: Record<string, unknown> = {};
  const unknowns: unknown[] = [];
  for (const item of value) {
    if (typeof item === 'string' && CAPABILITY_KEY_SET.has(item)) {
      capability[item] = true;
    } else {
      unknowns.push(item);
    }
  }
  for (const key of REQUIRED_CAPABILITY_KEYS) {
    capability[key] ??= false;
  }
  return { capability, unknowns };
}

function capabilityTrueKeys(capability: Record<string, unknown>): string[] {
  return CAPABILITY_KEYS.filter((key) => capability[key] === true);
}

function unknownCapabilitiesOf(rawCapabilities: unknown): unknown[] {
  if (!Array.isArray(rawCapabilities)) return [];
  return rawCapabilities.filter(
    (item) => !(typeof item === 'string' && CAPABILITY_KEY_SET.has(item)),
  );
}

const modelsFromToml = (raw: unknown): unknown => {
  if (!isPlainObject(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(raw)) {
    out[id] = isPlainObject(entry) ? modelEntryFromToml(entry) : entry;
  }
  return out;
};

function modelEntryFromToml(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let extras: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(entry)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'capabilities') {
      if (Array.isArray(value)) {
        const { capability, unknowns } = capabilityFromArray(value);
        out['capability'] = capability;
        if (unknowns.length > 0) (extras ??= {})['capabilities'] = unknowns;
      } else {
        out[targetKey] = value;
      }
      continue;
    }
    if (targetKey === 'overrides' && isPlainObject(value)) {
      out[targetKey] = modelOverridesFromToml(value);
      continue;
    }
    if (targetKey === 'extras' && isPlainObject(value)) {
      extras = { ...value, ...extras };
      continue;
    }
    out[targetKey] = value;
  }
  if (extras !== undefined) out['extras'] = extras;
  return out;
}

function modelOverridesFromToml(overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'capabilities' && Array.isArray(value)) {
      out['capability'] = capabilityFromArray(value).capability;
      continue;
    }
    out[targetKey] = value;
  }
  return out;
}

const modelsToToml = (value: unknown, raw: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(raw);
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(value)) {
    out[id] = isPlainObject(entry) ? modelEntryToToml(entry, rawSub[id]) : entry;
  }
  return out;
};

function modelEntryToToml(
  entry: Record<string, unknown>,
  rawEntry: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawEntry);
  const extras = entry['extras'];
  const preserved =
    isPlainObject(extras) && Array.isArray(extras['capabilities'])
      ? (extras['capabilities'] as unknown[])
      : [];
  for (const [key, field] of Object.entries(entry)) {
    if (key === 'capability') {
      if (isPlainObject(field)) {
        out['capabilities'] = [...capabilityTrueKeys(field), ...preserved];
      } else {
        setDefined(out, 'capabilities', field);
      }
      continue;
    }
    if (key === 'overrides' && isPlainObject(field)) {
      out['overrides'] = modelOverridesToToml(field, out['overrides']);
      continue;
    }
    if (key === 'extras' && isPlainObject(field)) {
      const rest: Record<string, unknown> = { ...field };
      delete rest['capabilities'];
      setDefined(out, 'extras', Object.keys(rest).length > 0 ? cloneRecord(rest) : undefined);
      continue;
    }
    setDefined(out, camelToSnake(key), field);
  }
  return out;
}

function modelOverridesToToml(
  overrides: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  const out = cloneRecord(raw);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'capability') {
      if (isPlainObject(value)) {
        out['capabilities'] = [...capabilityTrueKeys(value), ...unknownCapabilitiesOf(out['capabilities'])];
      } else {
        setDefined(out, 'capabilities', value);
      }
      continue;
    }
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

const MODEL_OBJECT_FIELDS = new Set(
  Object.entries(CatalogModelConfigSchema.shape)
    .filter(
      ([key, field]) =>
        key !== 'capability' && unwrapWrapperSchema(field as z.ZodTypeAny) instanceof z.ZodObject,
    )
    .map(([key]) => camelToSnake(key)),
);

function unwrapWrapperSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap() as z.ZodTypeAny;
  }
  return current;
}

function collectMalformedModelEntries(rawModels: unknown): readonly ConfigDiagnostic[] {
  if (!isPlainObject(rawModels)) return [];
  const diagnostics: ConfigDiagnostic[] = [];
  for (const [alias, entry] of Object.entries(rawModels)) {
    if (!isPlainObject(entry)) continue;
    if (entry['model'] !== undefined || entry['name'] !== undefined) continue;
    diagnostics.push({
      section: MODELS_CONFIG_SECTION,
      severity: 'warning',
      message: malformedModelMessage(alias, entry),
    });
  }
  return diagnostics;
}

function malformedModelMessage(alias: string, entry: Record<string, unknown>): string {
  const base = `[models] entry '${alias}' is missing the 'model' field and cannot be used as a model`;
  const dottedAlias = dottedAliasSuffix(alias, entry);
  if (dottedAlias === undefined) return `${base}.`;
  return `${base}; if the alias contains dots, quote the table name (e.g. [models."${dottedAlias}"]).`;
}

function dottedAliasSuffix(alias: string, entry: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(entry)) {
    if (MODEL_OBJECT_FIELDS.has(key) || !isPlainObject(value)) continue;
    return dottedAliasSuffix(`${alias}.${key}`, value) ?? `${alias}.${key}`;
  }
  return undefined;
}

const stripProvidersEnv = (value: ProvidersSection): ProvidersSection | undefined => {
  if (!isPlainObject(value)) return value;
  if (!(ENV_MODEL_PROVIDER_KEY in value)) return value;
  const out = { ...value };
  delete out[ENV_MODEL_PROVIDER_KEY];
  return out;
};

export const providersConfigSection: ConfigSectionContribution<ProvidersSection> = {
  name: PROVIDERS_CONFIG_SECTION,
  schema: ProvidersSectionSchema,
  defaultValue: {},
  merge: deepMerge,
  envBindings: {
    [ENV_MODEL_PROVIDER_KEY]: {
      apiKey: 'KIMI_MODEL_API_KEY',
      type: 'KIMI_MODEL_PROVIDER_TYPE',
      baseUrl: 'KIMI_MODEL_BASE_URL',
    },
  },
  stripEnv: stripProvidersEnv,
  fromToml: providersFromToml,
  toToml: providersToToml,
};

export const modelsConfigSection: ConfigSectionContribution<ModelsSection> = {
  name: MODELS_CONFIG_SECTION,
  schema: ModelsSectionSchema,
  defaultValue: {},
  fromToml: modelsFromToml,
  toToml: modelsToToml,
  collectDiagnostics: collectMalformedModelEntries,
};

export const thinkingConfigSection: ConfigSectionContribution<ThinkingConfig> = {
  name: THINKING_CONFIG_SECTION,
  schema: ThinkingConfigSchema,
  envBindings: {
    forcedEffort: 'KIMI_MODEL_THINKING_EFFORT',
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.forcedEffort;
    return out;
  },
};

export const modelCatalogConfigSection: ConfigSectionContribution<ModelCatalogConfig> = {
  name: MODEL_CATALOG_CONFIG_SECTION,
  schema: ModelCatalogConfigSchema,
};

export const defaultModelConfigSection: ConfigSectionContribution<string> = {
  name: DEFAULT_MODEL_CONFIG_SECTION,
  schema: z.string().min(1),
};
