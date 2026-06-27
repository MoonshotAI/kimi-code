import { ErrorCodes, KimiError } from '#/errors';
import { parseBooleanEnv } from './resolve';
import {
  validateConfig,
  type KimiConfig,
  type ModelAlias,
  type ProviderConfig,
  type ProviderType,
  type ThinkingConfig,
} from './schema';

/** Reserved keys for the env-driven synthetic provider / model alias. */
export const ENV_MODEL_PROVIDER_KEY = '__kimi_env__';
export const ENV_MODEL_ALIAS_KEY = '__kimi_env_model__';

const ALLOWED_TYPES: readonly ProviderType[] = ['kimi', 'anthropic', 'openai'];

const DEFAULT_BASE_URL: Partial<Record<ProviderType, string>> = {
  kimi: 'https://api.moonshot.ai/v1',
  openai: 'https://api.openai.com/v1',
  // anthropic: omitted -> let the Anthropic SDK pick its default
};

/** Default context window (256K) used when KIMI_MODEL_MAX_CONTEXT_SIZE is unset. */
const DEFAULT_MAX_CONTEXT_SIZE = 262144;

/** Default capabilities when KIMI_MODEL_CAPABILITIES is unset (kimi models support both). */
const DEFAULT_CAPABILITIES = ['image_in', 'thinking'];

type Env = Readonly<Record<string, string | undefined>>;

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

function fail(message: string): never {
  throw new KimiError(ErrorCodes.CONFIG_INVALID, message);
}

function parsePositiveInt(raw: string, varName: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    fail(`${varName} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

function parseProviderType(raw: string | undefined): ProviderType {
  if (raw === undefined) return 'kimi';
  const normalized = raw.toLowerCase() as ProviderType;
  if (!ALLOWED_TYPES.includes(normalized)) {
    fail(
      `KIMI_MODEL_PROVIDER_TYPE must be one of ${ALLOWED_TYPES.join(', ')}, got "${raw}".`,
    );
  }
  return normalized;
}

function parseCapabilities(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const caps = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  return caps.length === 0 ? undefined : caps;
}

// `parseBooleanEnv` returns undefined for unrecognized input. Treat a non-empty
// but unparseable value (e.g. a typo like `flase`) as a config error so it
// fails fast like the other KIMI_MODEL_* values, instead of silently keeping
// config.toml's existing value.
function parseBooleanVar(raw: string | undefined, varName: string): boolean | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  const parsed = parseBooleanEnv(value);
  if (parsed === undefined) {
    fail(`${varName} must be a boolean (true/false/1/0/yes/no/on/off), got "${raw}".`);
  }
  return parsed;
}

/**
 * When `KIMI_MODEL_NAME` is set, synthesize one provider + one model alias from
 * the `KIMI_MODEL_*` environment variables and make it the default model.
 * Returns the config unchanged when the trigger variable is absent.
 *
 * IMPORTANT: the synthesized provider/model/default_model exist ONLY in the
 * in-memory runtime config and must never be serialized back to config.toml.
 * Two layers enforce this: write paths read the raw config via `readConfigFile`,
 * and `writeConfigFile` strips the reserved entries via `stripEnvModelConfig` as
 * a final guard against patch round-trips (getConfig -> setConfig).
 */
export function applyEnvModelConfig(config: KimiConfig, env: Env = process.env): KimiConfig {
  const model = trimmed(env['KIMI_MODEL_NAME']);
  if (model === undefined) return config;

  const apiKey = trimmed(env['KIMI_MODEL_API_KEY']);
  if (apiKey === undefined) {
    fail('KIMI_MODEL_NAME is set but KIMI_MODEL_API_KEY is missing.');
  }

  const maxContextRaw = trimmed(env['KIMI_MODEL_MAX_CONTEXT_SIZE']);
  const maxContextSize =
    maxContextRaw === undefined
      ? DEFAULT_MAX_CONTEXT_SIZE
      : parsePositiveInt(maxContextRaw, 'KIMI_MODEL_MAX_CONTEXT_SIZE');

  const type = parseProviderType(trimmed(env['KIMI_MODEL_PROVIDER_TYPE']));
  const baseUrl = trimmed(env['KIMI_MODEL_BASE_URL']) ?? DEFAULT_BASE_URL[type];

  const provider: ProviderConfig = {
    type,
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };

  const maxOutputRaw = trimmed(env['KIMI_MODEL_MAX_OUTPUT_SIZE']);
  const maxOutputSize =
    maxOutputRaw !== undefined
      ? parsePositiveInt(maxOutputRaw, 'KIMI_MODEL_MAX_OUTPUT_SIZE')
      : undefined;
  const capabilities = parseCapabilities(env['KIMI_MODEL_CAPABILITIES']) ?? DEFAULT_CAPABILITIES;
  const displayName = trimmed(env['KIMI_MODEL_DISPLAY_NAME']);
  const reasoningKey = trimmed(env['KIMI_MODEL_REASONING_KEY']);
  const adaptiveThinking = parseBooleanVar(
    env['KIMI_MODEL_ADAPTIVE_THINKING'],
    'KIMI_MODEL_ADAPTIVE_THINKING',
  );

  const alias: ModelAlias = {
    provider: ENV_MODEL_PROVIDER_KEY,
    model,
    maxContextSize,
    capabilities,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(maxOutputSize !== undefined ? { maxOutputSize } : {}),
    ...(reasoningKey !== undefined ? { reasoningKey } : {}),
    ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
  };

  const thinkingEffort = trimmed(env['KIMI_MODEL_THINKING_EFFORT']);
  const thinking: ThinkingConfig | undefined =
    thinkingEffort !== undefined ? { ...config.thinking, effort: thinkingEffort } : config.thinking;

  const merged: KimiConfig = {
    ...config,
    providers: { ...config.providers, [ENV_MODEL_PROVIDER_KEY]: provider },
    models: { ...config.models, [ENV_MODEL_ALIAS_KEY]: alias },
    defaultModel: ENV_MODEL_ALIAS_KEY,
    ...(thinking !== undefined ? { thinking } : {}),
  };

  // Re-validate so the synthesized entries honor the same schema constraints.
  // `validateConfig` throws KimiError(CONFIG_INVALID) on violation, matching
  // the explicit checks above.
  return validateConfig(merged);
}

/**
 * Remove the env-synthesized provider/model before a config is persisted to
 * disk. Mirror of {@link applyEnvModelConfig}: that injects the reserved entries
 * into the in-memory runtime config; this guarantees they never reach
 * config.toml — including via a `getConfig` -> `setConfig` patch round-trip,
 * where the runtime config (carrying the env provider and its shell API key)
 * would otherwise be merged back and written out. Every env-injected top-level
 * field (default_model, thinking) is restored to its on-disk
 * value from `config.raw` rather than erased, so real values already in
 * config.toml survive the round-trip.
 */
export function stripEnvModelConfig(config: KimiConfig): KimiConfig {
  const hasProvider = ENV_MODEL_PROVIDER_KEY in config.providers;
  const hasModel = config.models !== undefined && ENV_MODEL_ALIAS_KEY in config.models;
  const defaultIsEnv = config.defaultModel === ENV_MODEL_ALIAS_KEY;
  if (!hasProvider && !hasModel && !defaultIsEnv) return config;

  const providers = { ...config.providers };
  delete providers[ENV_MODEL_PROVIDER_KEY];

  let models = config.models;
  if (models !== undefined && ENV_MODEL_ALIAS_KEY in models) {
    models = { ...models };
    delete models[ENV_MODEL_ALIAS_KEY];
  }

  return {
    ...config,
    providers,
    ...(models !== undefined ? { models } : {}),
    // Restore env-injected top-level fields from raw instead of persisting the
    // shell overrides: the env default_model (when it points at the env alias),
    // and the env thinking. Reaching here means env-model mode is active (the
    // synthetic provider/model exist), so these may be env values; an unset raw
    // field restores to undefined (i.e. drops it).
    ...(defaultIsEnv ? { defaultModel: rawDefaultModel(config) } : {}),
    thinking: rawThinking(config),
  };
}

function rawDefaultModel(config: KimiConfig): string | undefined {
  const raw = config.raw?.['default_model'];
  return typeof raw === 'string' ? raw : undefined;
}

function rawThinking(config: KimiConfig): ThinkingConfig | undefined {
  const raw = config.raw?.['thinking'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as ThinkingConfig)
    : undefined;
}
