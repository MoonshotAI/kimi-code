/**
 * `auth` domain (L2) — `services` config-section schema and TOML transforms.
 *
 * Owns the `[services]` configuration section (`moonshot_search` /
 * `moonshot_fetch`), mirroring v1's `ServicesConfigSchema`: the schema, and the
 * snake_case ↔ camelCase TOML transforms (including the nested `oauth` and
 * `custom_headers` normalization, with `custom_headers` record keys preserved
 * verbatim). Self-registered at module load via `registerConfigSection`, so the
 * `config` domain never imports this domain's types.
 *
 * The `auth` domain owns this section because its OAuth login/logout flows
 * provision and clear it (see `authService`) and its `WebSearchProviderService`
 * consumes `moonshot_search`; the `web` domain reads `moonshot_fetch` from the
 * same section. Bound at App scope.
 */

import { z } from 'zod';

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
import { OAuthRefSchema } from '#/app/provider/provider';

export const SERVICES_SECTION = 'services';

const StringRecordSchema = z.record(z.string(), z.string());

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
});
