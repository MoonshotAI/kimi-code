/**
 * `kosong/provider` domain (L2) — `providers` config-section schema, env
 * bindings, and TOML transforms.
 *
 * Owns the `[providers.<name>]` configuration section: its schema (with the
 * free-form `type` field), the `KIMI_MODEL_PROVIDER_TYPE` /
 * `KIMI_MODEL_API_KEY` / `KIMI_MODEL_BASE_URL` environment bindings that
 * synthesize the reserved `__kimi_env__` provider entry, and the snake_case ↔
 * camelCase TOML transforms (including the nested `oauth` / `env` /
 * `custom_headers` normalization). Self-registered at module load via
 * `registerConfigSection`, so the `config` domain never imports this domain's
 * types.
 *
 * Side-effect module: production gets it from the `src/index.ts`
 * side-effect block; tests import it on demand. This module is the sole
 * owner of the section — the legacy `app/provider/configSection` is gone.
 *
 * Note: the `app/config` imports below are deliberately RELATIVE paths — see
 * `providerService.ts` for the rationale.
 */

import { type ConfigStripEnv, envBindings } from '../../app/config/config';
import { registerConfigSection } from '../../app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  snakeToCamel,
  transformPlainObject,
} from '../../app/config/toml';
import {
  ENV_MODEL_PROVIDER_KEY,
  PROVIDERS_SECTION,
  ProviderConfigSchema,
  ProvidersSectionSchema,
} from './provider';

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
