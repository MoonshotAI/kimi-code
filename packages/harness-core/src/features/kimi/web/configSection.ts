import { z } from 'zod';

import {
  camelToSnake,
  CatalogOAuthRefSchema,
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  snakeToCamel,
  transformPlainObject,
  type ConfigOverlayContribution,
  type ConfigSectionContribution,
  type ConfigStripEnv,
  type EnvBindings,
} from '@moonshot-ai/agent-core';

import { stripEnvBoundFields } from '#/config-env';

export const SERVICES_CONFIG_SECTION = 'services';

export const WEB_SEARCH_BASE_URL_ENV = 'KIMI_WEB_SEARCH_BASE_URL';

export const WEB_SEARCH_API_KEY_ENV = 'KIMI_WEB_SEARCH_API_KEY';

export const WEB_FETCH_BASE_URL_ENV = 'KIMI_WEB_FETCH_BASE_URL';

export const WEB_FETCH_API_KEY_ENV = 'KIMI_WEB_FETCH_API_KEY';

const StringRecordSchema = z.record(z.string(), z.string());

export const MoonshotServiceEntrySchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: CatalogOAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

export type MoonshotServiceEntry = z.infer<typeof MoonshotServiceEntrySchema>;

export const ServicesSectionSchema = z.looseObject({
  moonshot_search: MoonshotServiceEntrySchema.optional(),
  moonshot_fetch: MoonshotServiceEntrySchema.optional(),
});

export type ServicesSection = z.infer<typeof ServicesSectionSchema>;

const nonBlankEnv = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const moonshotSearchEnvBindings: EnvBindings<MoonshotServiceEntry> = {
  baseUrl: { env: WEB_SEARCH_BASE_URL_ENV, parse: nonBlankEnv },
  apiKey: { env: WEB_SEARCH_API_KEY_ENV, parse: nonBlankEnv },
};

const moonshotFetchEnvBindings: EnvBindings<MoonshotServiceEntry> = {
  baseUrl: { env: WEB_FETCH_BASE_URL_ENV, parse: nonBlankEnv },
  apiKey: { env: WEB_FETCH_API_KEY_ENV, parse: nonBlankEnv },
};

const servicesEnvBindings: EnvBindings<ServicesSection> = {
  moonshot_search: moonshotSearchEnvBindings,
  moonshot_fetch: moonshotFetchEnvBindings,
};

export const servicesCredentialEnvOverlay: ConfigOverlayContribution = {
  name: 'services-credential-env',
  apply(effective, getEnv, validate) {
    const services = effective[SERVICES_CONFIG_SECTION];
    if (!isPlainObject(services)) return;
    const moonshotSearch = isolateEnvServiceCredentials(
      services['moonshot_search'],
      getEnv,
      WEB_SEARCH_BASE_URL_ENV,
      WEB_SEARCH_API_KEY_ENV,
    );
    const moonshotFetch = isolateEnvServiceCredentials(
      services['moonshot_fetch'],
      getEnv,
      WEB_FETCH_BASE_URL_ENV,
      WEB_FETCH_API_KEY_ENV,
    );
    if (
      moonshotSearch === services['moonshot_search'] &&
      moonshotFetch === services['moonshot_fetch']
    ) {
      return;
    }
    effective[SERVICES_CONFIG_SECTION] = validate(SERVICES_CONFIG_SECTION, {
      ...services,
      moonshot_search: moonshotSearch,
      moonshot_fetch: moonshotFetch,
    });
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

const stripMoonshotSearchEnv = stripEnvBoundFields<MoonshotServiceEntry>(moonshotSearchEnvBindings);
const stripMoonshotFetchEnv = stripEnvBoundFields<MoonshotServiceEntry>(moonshotFetchEnvBindings);

const stripServicesEnv: ConfigStripEnv<ServicesSection> = (value, raw, getEnv) => {
  if (!isPlainObject(value)) return value;
  let out: ServicesSection | undefined;
  for (const [key, strip] of [
    ['moonshot_search', stripMoonshotSearchEnv],
    ['moonshot_fetch', stripMoonshotFetchEnv],
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

const servicesFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawSnake)) {
    out[name] = isPlainObject(entry) ? serviceEntryFromToml(entry) : entry;
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

const servicesToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  writeService(out, 'moonshot_search', value['moonshot_search']);
  writeService(out, 'moonshot_fetch', value['moonshot_fetch']);
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
      out['oauth'] = plainObjectToToml(value, undefined);
    } else if (key === 'customHeaders' && value !== undefined) {
      out['custom_headers'] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

export const servicesConfigSection: ConfigSectionContribution<ServicesSection> = {
  name: SERVICES_CONFIG_SECTION,
  schema: ServicesSectionSchema,
  defaultValue: {},
  envBindings: servicesEnvBindings,
  stripEnv: stripServicesEnv,
  fromToml: servicesFromToml,
  toToml: servicesToToml,
};
