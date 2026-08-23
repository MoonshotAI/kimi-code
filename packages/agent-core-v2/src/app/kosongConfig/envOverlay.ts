import { parseBooleanEnv } from '#/_base/utils/env';
import { Error2 } from '#/_base/errors/errors';

import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import { resolveProviderEndpoint } from '#/kosong/provider/providerDefinition';

import { ENV_MODEL_PROVIDER_KEY } from './configSection';

export const ENV_MODEL_ALIAS_KEY = '__kimi_env_model__';

const DEFAULT_MAX_CONTEXT_SIZE = 262144;

const DEFAULT_CAPABILITIES = ['image_in', 'thinking'];

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

function fail(message: string): never {
  throw new Error2(CONFIG_INVALID_ERROR_CODE, message);
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
  const parsed = parseBooleanEnv(value);
  if (parsed === undefined) {
    fail(`${varName} must be a boolean (true/false/1/0/yes/no/on/off), got "${raw}".`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withoutKey(value: unknown, key: string): unknown {
  if (
    !(typeof value === 'object' && value !== null && !Array.isArray(value) && key in value)
  ) {
    return value;
  }
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete out[key];
  return out;
}

export const kimiModelEnvOverlay: ConfigEffectiveOverlay = {
  apply(effective, getEnv, validate) {
    const model = trimmed(getEnv('KIMI_MODEL_NAME'));
    const temperature = parseFloatEnv(
      getEnv('KIMI_MODEL_TEMPERATURE'),
      'KIMI_MODEL_TEMPERATURE',
    );
    const topP = parseFloatEnv(getEnv('KIMI_MODEL_TOP_P'), 'KIMI_MODEL_TOP_P');
    const thinkingKeep = trimmed(getEnv('KIMI_MODEL_THINKING_KEEP'));
    const maxCompletionTokens =
      parseCompletionTokens(getEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS')) ??
      parseCompletionTokens(getEnv('KIMI_MODEL_MAX_TOKENS'));

    const changed: string[] = [];

    if (model === undefined) {
      const modelOverrides = collectModelOverrides({
        temperature,
        topP,
        thinkingKeep,
        maxCompletionTokens,
      });
      if (modelOverrides !== undefined) {
        effective['modelOverrides'] = modelOverrides;
        changed.push('modelOverrides');
      }
      return changed;
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

    const alias: Record<string, unknown> = {
      provider: ENV_MODEL_PROVIDER_KEY,
      model,
      maxContextSize,
      capabilities,
    };
    if (displayName !== undefined) alias['displayName'] = displayName;
    if (maxOutputSize !== undefined) alias['maxOutputSize'] = maxOutputSize;
    if (reasoningKey !== undefined) alias['reasoningKey'] = reasoningKey;
    if (adaptiveThinking !== undefined) alias['adaptiveThinking'] = adaptiveThinking;

    const models = asRecord(effective['models']);
    const nextModels = { ...models, [ENV_MODEL_ALIAS_KEY]: alias };
    effective['models'] = validate('models', nextModels);
    changed.push('models');

    const providers = asRecord(effective['providers']);
    const envProvider = asRecord(providers[ENV_MODEL_PROVIDER_KEY]);
    const providerType =
      typeof envProvider['type'] === 'string' ? envProvider['type'] : 'kimi';
    const providerBaseUrl =
      typeof envProvider['baseUrl'] === 'string' && envProvider['baseUrl'].length > 0
        ? envProvider['baseUrl']
        :
          resolveProviderEndpoint(providerType, envBagOf(getEnv)).baseUrl;
    const providerPatch: Record<string, unknown> = {};
    if (envProvider['type'] === undefined) providerPatch['type'] = 'kimi';
    if (providerBaseUrl !== undefined && envProvider['baseUrl'] === undefined) {
      providerPatch['baseUrl'] = providerBaseUrl;
    }
    if (Object.keys(providerPatch).length > 0) {
      effective['providers'] = validate('providers', {
        ...providers,
        [ENV_MODEL_PROVIDER_KEY]: { ...envProvider, ...providerPatch },
      });
      changed.push('providers');
    }

    effective['defaultModel'] = ENV_MODEL_ALIAS_KEY;
    changed.push('defaultModel');

    const modelOverrides = collectModelOverrides({
      temperature,
      topP,
      thinkingKeep,
      maxCompletionTokens,
    });
    if (modelOverrides !== undefined) {
      effective['modelOverrides'] = modelOverrides;
      changed.push('modelOverrides');
    }

    return changed;
  },

  strip(domain, value, rawSnake) {
    switch (domain) {
      case 'models':
        return withoutKey(value, ENV_MODEL_ALIAS_KEY);
      case 'defaultModel':
        if (value !== ENV_MODEL_ALIAS_KEY) return value;
        return typeof rawSnake['default_model'] === 'string' ? rawSnake['default_model'] : undefined;
      case 'modelOverrides':
        return undefined;
      default:
        return value;
    }
  },
};

function envBagOf(
  getEnv: (name: string) => string | undefined,
): Readonly<Record<string, string | undefined>> {
  return new Proxy<Record<string, string | undefined>>({}, {
    get: (_target, key: string) => getEnv(key),
  });
}

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

registerConfigOverlay(kimiModelEnvOverlay);
