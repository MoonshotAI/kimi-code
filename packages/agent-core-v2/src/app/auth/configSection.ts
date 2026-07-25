/**
 * `auth` domain (L2) — `services` config-section schema, TOML transforms, and
 * env bindings.
 *
 * Owns the `[services]` configuration section (`moonshot_search` /
 * `moonshot_fetch`), mirroring v1's `ServicesConfigSchema`: the schema, and the
 * snake_case ↔ camelCase TOML transforms (including the nested `oauth` and
 * `custom_headers` normalization, with `custom_headers` record keys preserved
 * verbatim). Both entries' `base_url` / `api_key` are env-overridable
 * (`KIMI_WEB_SEARCH_*` / `KIMI_WEB_FETCH_*`, env wins over the file). Its
 * effective overlay treats an env base URL as a new credential boundary and
 * prevents persisted API keys, OAuth refs, or custom headers from crossing
 * into that endpoint; the composed `stripEnv` keeps env-derived values from
 * being persisted.
 * Self-registered at module load via `registerConfigSection`, so the
 * `config` domain never imports this domain's types.
 *
 * The `auth` domain owns this section because its OAuth login/logout flows
 * provision and clear it (see `authService`) and its `WebSearchProviderService`
 * consumes `moonshot_search`; the `web` domain reads `moonshot_fetch` from the
 * same section. Bound at App scope.
 */

import { z } from 'zod';

import {
  type ConfigEffectiveOverlay,
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
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
import type { OAuthRef } from '#/kosong/provider/provider';

export const SERVICES_SECTION = 'services';

const StringRecordSchema = z.record(z.string(), z.string());

// Local re-derivation of kosong's `OAuthRef` type: the canonical section
// schema lives in `app/kosongConfig` (L3), which this L2 domain must not
// import. The `AssertExact` pin keeps this copy in lockstep with the type.
const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

type _AssertOAuthRef = AssertExact<Equal<z.infer<typeof OAuthRefSchema>, OAuthRef>>;

export const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

export type MoonshotServiceConfig = z.infer<typeof MoonshotServiceConfigSchema>;

export const ServicesConfigSchema = z
  .object({
    moonshotSearch: MoonshotServiceConfigSchema.optional(),
    moonshotFetch: MoonshotServiceConfigSchema.optional(),
  })
  .passthrough();

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

export const WEB_SEARCH_BASE_URL_ENV = 'KIMI_WEB_SEARCH_BASE_URL';
export const WEB_SEARCH_API_KEY_ENV = 'KIMI_WEB_SEARCH_API_KEY';
export const WEB_FETCH_BASE_URL_ENV = 'KIMI_WEB_FETCH_BASE_URL';
export const WEB_FETCH_API_KEY_ENV = 'KIMI_WEB_FETCH_API_KEY';

const nonBlankEnv = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const moonshotSearchEnvBindings = envBindings(MoonshotServiceConfigSchema, {
  baseUrl: { env: WEB_SEARCH_BASE_URL_ENV, parse: nonBlankEnv },
  apiKey: { env: WEB_SEARCH_API_KEY_ENV, parse: nonBlankEnv },
});

const moonshotFetchEnvBindings = envBindings(MoonshotServiceConfigSchema, {
  baseUrl: { env: WEB_FETCH_BASE_URL_ENV, parse: nonBlankEnv },
  apiKey: { env: WEB_FETCH_API_KEY_ENV, parse: nonBlankEnv },
});

export const servicesEnvBindings: EnvBindings<ServicesConfig> = envBindings(
  ServicesConfigSchema,
  {
    moonshotSearch: moonshotSearchEnvBindings,
    moonshotFetch: moonshotFetchEnvBindings,
  },
);

const servicesCredentialEnvOverlay: ConfigEffectiveOverlay = {
  apply(effective, getEnv, validate) {
    const services = effective[SERVICES_SECTION];
    if (!isPlainObject(services)) return [];
    const moonshotSearch = isolateEnvServiceCredentials(
      services['moonshotSearch'],
      getEnv,
      WEB_SEARCH_BASE_URL_ENV,
      WEB_SEARCH_API_KEY_ENV,
    );
    const moonshotFetch = isolateEnvServiceCredentials(
      services['moonshotFetch'],
      getEnv,
      WEB_FETCH_BASE_URL_ENV,
      WEB_FETCH_API_KEY_ENV,
    );
    if (
      moonshotSearch === services['moonshotSearch'] &&
      moonshotFetch === services['moonshotFetch']
    ) {
      return [];
    }
    effective[SERVICES_SECTION] = validate(SERVICES_SECTION, {
      ...services,
      moonshotSearch,
      moonshotFetch,
    });
    return [SERVICES_SECTION];
  },
};

function isolateEnvServiceCredentials(
  service: unknown,
  getEnv: (name: string) => string | undefined,
  baseUrlEnv: string,
  apiKeyEnv: string,
): unknown {
  const baseUrl = nonBlankEnv(getEnv(baseUrlEnv) ?? '');
  const apiKey = nonBlankEnv(getEnv(apiKeyEnv) ?? '');
  if (baseUrl !== undefined) return { baseUrl, apiKey };
  if (apiKey === undefined) return service;
  if (!isPlainObject(service)) return { apiKey };
  const { apiKey: _apiKey, oauth: _oauth, ...rest } = service;
  return { ...rest, apiKey };
}

const stripMoonshotSearchEnv = stripEnvBoundFields(moonshotSearchEnvBindings);
const stripMoonshotFetchEnv = stripEnvBoundFields(moonshotFetchEnvBindings);

export const stripServicesEnv: ConfigStripEnv<ServicesConfig> = (value, raw, getEnv) => {
  if (!isPlainObject(value)) return value;
  let out: ServicesConfig | undefined;
  for (const [key, strip] of [
    ['moonshotSearch', stripMoonshotSearchEnv],
    ['moonshotFetch', stripMoonshotFetchEnv],
  ] as const) {
    const entry = value[key];
    if (entry === undefined) continue;
    const stripped = strip(entry, isPlainObject(raw) ? raw[key] : undefined, getEnv);
    if (stripped === entry) continue;
    out ??= { ...value };
    if (stripped === undefined) {
      delete out[key];
    } else {
      out[key] = stripped;
    }
  }
  return out ?? value;
};

export const servicesFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawSnake)) {
    out[snakeToCamel(name)] = isPlainObject(entry) ? serviceEntryFromToml(entry) : entry;
  }
  return out;
};

function serviceEntryFromToml(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      out[targetKey] = isPlainObject(value) ? cloneRecord(value) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

export const servicesToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  writeService(out, 'moonshot_search', value['moonshotSearch']);
  writeService(out, 'moonshot_fetch', value['moonshotFetch']);
  return out;
};

function writeService(out: Record<string, unknown>, snakeKey: string, service: unknown): void {
  if (isPlainObject(service)) {
    out[snakeKey] = serviceEntryToToml(service);
  } else {
    delete out[snakeKey];
  }
}

function serviceEntryToToml(service: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = plainObjectToToml(value, undefined);
    } else if (key === 'customHeaders' && value !== undefined) {
      out[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

registerConfigSection(SERVICES_SECTION, ServicesConfigSchema, {
  fromToml: servicesFromToml,
  toToml: servicesToToml,
  env: servicesEnvBindings,
  stripEnv: stripServicesEnv,
});
registerConfigOverlay(servicesCredentialEnvOverlay);
