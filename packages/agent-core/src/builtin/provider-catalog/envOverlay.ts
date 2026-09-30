import {
  isPlainObject,
  type ConfigOverlayContribution,
  type GetEnv,
} from '#/builtin/config/index';

import {
  DEFAULT_MODEL_CONFIG_SECTION,
  ENV_MODEL_PROVIDER_KEY,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  capabilityFromArray,
} from './configSections';

export const ENV_MODEL_ALIAS_KEY = '__kimi_env_model__';

export const MODEL_OVERRIDES_CONFIG_SECTION = 'modelOverrides';

const DEFAULT_MAX_CONTEXT_SIZE = 262144;

const DEFAULT_CAPABILITIES = ['image_in', 'thinking'];

const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

const ENDPOINT_BASE_URL_ENV: Readonly<Record<string, readonly string[]>> = {
  kimi: ['KIMI_BASE_URL'],
  openai: ['OPENAI_BASE_URL'],
  openai_responses: ['OPENAI_BASE_URL'],
  anthropic: ['ANTHROPIC_BASE_URL'],
  'google-genai': ['GOOGLE_VERTEX_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
};

const ENDPOINT_DEFAULT_BASE_URL: Readonly<Record<string, string>> = {
  kimi: KIMI_DEFAULT_BASE_URL,
};

const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

function fail(message: string): never {
  throw new Error(message);
}

function parsePositiveInt(raw: string, varName: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    fail(`${varName} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

function parseFloatEnv(raw: string | undefined, varName: string): number | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`${varName} must be a number, got "${raw}".`);
  }
  return parsed;
}

function parseCompletionTokens(raw: string | undefined): number | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  return parsed;
}

function parseCapabilities(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const caps = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  return caps.length === 0 ? undefined : caps;
}

function parseBooleanVar(raw: string | undefined, varName: string): boolean | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  fail(`${varName} must be a boolean (true/false/1/0/yes/no/on/off), got "${raw}".`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function withoutKey(value: unknown, key: string): unknown {
  if (!(isPlainObject(value) && key in value)) {
    return value;
  }
  const out: Record<string, unknown> = { ...value };
  delete out[key];
  return out;
}

function resolveEnvProviderBaseUrl(providerType: string, getEnv: GetEnv): string | undefined {
  const names = ENDPOINT_BASE_URL_ENV[providerType];
  if (names === undefined) return undefined;
  for (const name of names) {
    const value = getEnv(name);
    if (value !== undefined && value.length > 0) return value;
  }
  return ENDPOINT_DEFAULT_BASE_URL[providerType];
}

export const kimiModelEnvOverlay: ConfigOverlayContribution = {
  name: 'kimi-model-env',
  apply(effective, getEnv, validate) {
    const model = trimmed(getEnv('KIMI_MODEL_NAME'));
    const temperature = parseFloatEnv(getEnv('KIMI_MODEL_TEMPERATURE'), 'KIMI_MODEL_TEMPERATURE');
    const topP = parseFloatEnv(getEnv('KIMI_MODEL_TOP_P'), 'KIMI_MODEL_TOP_P');
    const thinkingKeep = trimmed(getEnv('KIMI_MODEL_THINKING_KEEP'));
    const maxCompletionTokens =
      parseCompletionTokens(getEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS')) ??
      parseCompletionTokens(getEnv('KIMI_MODEL_MAX_TOKENS'));

    if (model === undefined) {
      const modelOverrides = collectModelOverrides({
        temperature,
        topP,
        thinkingKeep,
        maxCompletionTokens,
      });
      if (modelOverrides !== undefined) {
        effective[MODEL_OVERRIDES_CONFIG_SECTION] = modelOverrides;
      }
      return;
    }

    const maxContextRaw = trimmed(getEnv('KIMI_MODEL_MAX_CONTEXT_SIZE'));
    const maxContextSize =
      maxContextRaw === undefined
        ? DEFAULT_MAX_CONTEXT_SIZE
        : parsePositiveInt(maxContextRaw, 'KIMI_MODEL_MAX_CONTEXT_SIZE');

    const maxOutputRaw = trimmed(getEnv('KIMI_MODEL_MAX_OUTPUT_SIZE'));
    const maxOutputSize =
      maxOutputRaw === undefined
        ? undefined
        : parsePositiveInt(maxOutputRaw, 'KIMI_MODEL_MAX_OUTPUT_SIZE');
    const capabilities = parseCapabilities(getEnv('KIMI_MODEL_CAPABILITIES')) ?? DEFAULT_CAPABILITIES;
    const displayName = trimmed(getEnv('KIMI_MODEL_DISPLAY_NAME'));
    const reasoningKey = trimmed(getEnv('KIMI_MODEL_REASONING_KEY'));
    const adaptiveThinking = parseBooleanVar(
      getEnv('KIMI_MODEL_ADAPTIVE_THINKING'),
      'KIMI_MODEL_ADAPTIVE_THINKING',
    );

    const { capability, unknowns } = capabilityFromArray(capabilities);
    const alias: Record<string, unknown> = {
      provider: ENV_MODEL_PROVIDER_KEY,
      model,
      maxContextSize,
      capability,
    };
    if (unknowns.length > 0) alias['extras'] = { capabilities: unknowns };
    if (displayName !== undefined) alias['displayName'] = displayName;
    if (maxOutputSize !== undefined) alias['maxOutputSize'] = maxOutputSize;
    if (reasoningKey !== undefined) alias['reasoningKey'] = reasoningKey;
    if (adaptiveThinking !== undefined) alias['adaptiveThinking'] = adaptiveThinking;

    const models = asRecord(effective[MODELS_CONFIG_SECTION]);
    effective[MODELS_CONFIG_SECTION] = validate(MODELS_CONFIG_SECTION, {
      ...models,
      [ENV_MODEL_ALIAS_KEY]: alias,
    });

    const providers = asRecord(effective[PROVIDERS_CONFIG_SECTION]);
    const envProvider = asRecord(providers[ENV_MODEL_PROVIDER_KEY]);
    const providerType =
      typeof envProvider['type'] === 'string' ? envProvider['type'] : 'kimi';
    const providerBaseUrl =
      typeof envProvider['baseUrl'] === 'string' && envProvider['baseUrl'].length > 0
        ? envProvider['baseUrl']
        : resolveEnvProviderBaseUrl(providerType, getEnv);
    const providerPatch: Record<string, unknown> = {};
    if (envProvider['type'] === undefined) providerPatch['type'] = 'kimi';
    if (providerBaseUrl !== undefined && envProvider['baseUrl'] === undefined) {
      providerPatch['baseUrl'] = providerBaseUrl;
    }
    if (Object.keys(providerPatch).length > 0) {
      effective[PROVIDERS_CONFIG_SECTION] = validate(PROVIDERS_CONFIG_SECTION, {
        ...providers,
        [ENV_MODEL_PROVIDER_KEY]: { ...envProvider, ...providerPatch },
      });
    }

    effective[DEFAULT_MODEL_CONFIG_SECTION] = ENV_MODEL_ALIAS_KEY;

    const modelOverrides = collectModelOverrides({
      temperature,
      topP,
      thinkingKeep,
      maxCompletionTokens,
    });
    if (modelOverrides !== undefined) {
      effective[MODEL_OVERRIDES_CONFIG_SECTION] = modelOverrides;
    }
  },

  strip(name, value, rawSnake) {
    switch (name) {
      case MODELS_CONFIG_SECTION:
        return withoutKey(value, ENV_MODEL_ALIAS_KEY);
      case DEFAULT_MODEL_CONFIG_SECTION:
        if (value !== ENV_MODEL_ALIAS_KEY) return value;
        return typeof rawSnake['default_model'] === 'string' ? rawSnake['default_model'] : undefined;
      case MODEL_OVERRIDES_CONFIG_SECTION:
        return undefined;
      default:
        return value;
    }
  },
};

function collectModelOverrides(input: {
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly thinkingKeep: string | undefined;
  readonly maxCompletionTokens: number | undefined;
}): Record<string, unknown> | undefined {
  const modelOverrides: Record<string, unknown> = {};
  if (input.temperature !== undefined) modelOverrides['temperature'] = input.temperature;
  if (input.topP !== undefined) modelOverrides['topP'] = input.topP;
  if (input.thinkingKeep !== undefined) modelOverrides['thinkingKeep'] = input.thinkingKeep;
  if (input.maxCompletionTokens !== undefined) {
    modelOverrides['maxCompletionTokens'] = input.maxCompletionTokens;
  }
  return Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined;
}
