import { z } from 'zod';

import { deepMerge, type ConfigSectionContribution } from '#/builtin/config/index';

export const PROVIDERS_CONFIG_SECTION = 'providers';

export const MODELS_CONFIG_SECTION = 'models';

export const THINKING_CONFIG_SECTION = 'thinking';

export const MODEL_CATALOG_CONFIG_SECTION = 'modelCatalog';

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

export const providersConfigSection: ConfigSectionContribution<ProvidersSection> = {
  name: PROVIDERS_CONFIG_SECTION,
  schema: ProvidersSectionSchema,
  defaultValue: {},
  merge: deepMerge,
};

export const modelsConfigSection: ConfigSectionContribution<ModelsSection> = {
  name: MODELS_CONFIG_SECTION,
  schema: ModelsSectionSchema,
  defaultValue: {},
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
