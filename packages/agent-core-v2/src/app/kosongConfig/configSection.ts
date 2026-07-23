/**
 * `kosongConfig` domain (L3) — config-section declarations for kosong.
 *
 * The persistence wrapper for kosong's provider/model registries and the
 * thinking / model-catalog preferences: declares every kosong-owned section
 * constant and its zod schema, plus the env bindings / write-path strips
 * and the snake_case ↔ camelCase TOML transforms. Where kosong owns a pure
 * type (`providers` / `models` / `thinking`), the schema is re-derived from
 * it and pinned by an `AssertExact` assertion (schema ≡ type at compile
 * time); `modelCatalog` has no kosong-side type and keeps its own local
 * schema. Self-registered at module load via `registerConfigSection`, so
 * the `config` domain never imports kosong types.
 *
 * `ProviderTypeSchema` is deliberately free-form text: vendor identity is
 * NOT enumerated at parse time. Validation happens at resolve time against
 * kosong's provider-definition registry, which is what allows external
 * packages to register new vendors without touching this schema.
 *
 * Side-effect module: production gets it from the `src/index.ts`
 * side-effect block; tests import it on demand.
 */

import { z } from 'zod';

import { type ConfigStripEnv, envBindings } from '#/app/config/config';
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

// ---------------------------------------------------------------------------
// `providers` — kosong's provider registry (types: `kosong/provider/provider`)
// ---------------------------------------------------------------------------

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
  customHeaders: StringRecordSchema.optional(),
  defaultModel: z.string().optional(),

  type: ProviderTypeSchema.optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

// Compile-time pins: the schemas must stay in lockstep with kosong's
// hand-written types (drift in either direction fails typecheck).
type _AssertOAuthRef = AssertExact<Equal<z.infer<typeof OAuthRefSchema>, OAuthRef>>;
type _AssertProviderConfig = AssertExact<
  Equal<z.infer<typeof ProviderConfigSchema>, ProviderConfig>
>;
type _AssertProvidersSection = AssertExact<
  Equal<z.infer<typeof ProvidersSectionSchema>, ProvidersSection>
>;

// The `KIMI_MODEL_PROVIDER_TYPE` / `KIMI_MODEL_API_KEY` / `KIMI_MODEL_BASE_URL`
// environment bindings synthesize the reserved `__kimi_env__` provider entry.
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

// ---------------------------------------------------------------------------
// `models` — kosong's model registry (types: `kosong/model/model`)
// ---------------------------------------------------------------------------

export const MODELS_SECTION = 'models';

/**
 * The global default-model pointer: a single model id from `[models.*]` used
 * whenever a call site does not name a model explicitly. Cross-domain by
 * nature — written by `IModelCatalog.setDefaultModel` and the OAuth login /
 * refresh flows (`app/auth`), read by runtime resolution fallbacks. The sole
 * owner of the key constant lives here; every consumer imports it.
 */
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

// Compile-time pins: the schemas must stay in lockstep with kosong's
// hand-written types (drift in either direction fails typecheck).
type _AssertModelOverride = AssertExact<
  Equal<z.infer<typeof ModelOverrideSchema>, ModelOverride>
>;
type _AssertModelRecord = AssertExact<Equal<z.infer<typeof ModelRecordSchema>, ModelRecord>>;
type _AssertModelsSection = AssertExact<
  Equal<z.infer<typeof ModelsSectionSchema>, ModelsSection>
>;

// The transforms preserve user-defined model ids (record keys) while
// converting each id's fields.
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
    const rawEntry = cloneRecord(rawSub[id]);
    const converted: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(entry)) {
      if (key === 'capabilities' && Array.isArray(field)) {
        converted[camelToSnake(key)] = [...field];
      } else if (key === 'overrides' && isPlainObject(field)) {
        converted['overrides'] = modelOverridesToToml(field, rawEntry['overrides']);
      } else {
        setDefined(converted, camelToSnake(key), field);
      }
    }
    out[id] = { ...rawEntry, ...converted };
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

// ---------------------------------------------------------------------------
// `thinking` — thinking defaults (type: `kosong/model/thinking`)
// ---------------------------------------------------------------------------

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  forcedEffort: z.string().optional(),
  keep: z.string().optional(),
});

// Compile-time pin: the schema must stay in lockstep with kosong's
// hand-written `ThinkingConfig` type (drift in either direction fails
// typecheck).
type _AssertThinkingConfig = AssertExact<
  Equal<z.infer<typeof ThinkingConfigSchema>, ThinkingConfig>
>;

// The `KIMI_MODEL_THINKING_EFFORT` env binding is an env-only forcedEffort
// override; the strip keeps it out of `config.toml`.
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
// `modelCatalog` — provider-model catalog auto-refresh cadence (no kosong type)
// ---------------------------------------------------------------------------

// Read by the kap-server model-catalog refresh scheduler to decide the
// refresh interval and whether to refresh once on start. Env vars
// (`KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS`,
// `KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START`) override these values at the
// scheduler edge.
export const MODEL_CATALOG_SECTION = 'modelCatalog';

export const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

registerConfigSection(MODEL_CATALOG_SECTION, ModelCatalogConfigSchema);
