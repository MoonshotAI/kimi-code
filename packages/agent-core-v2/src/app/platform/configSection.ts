/**
 * `platform` domain (L2) — `platforms` config-section schema and TOML
 * transforms.
 *
 * Owns the `[platforms.<name>]` section: its schema, the snake_case ↔
 * camelCase transforms (with nested `auth.oauth` / `auth.env` normalization),
 * and self-registration into `config`. `config` never imports this domain's
 * types.
 */

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

import { PLATFORMS_SECTION, PlatformsSectionSchema } from './platform';

export const platformsFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawSnake)) {
    out[name] = isPlainObject(entry) ? platformEntryFromToml(entry) : entry;
  }
  return out;
};

function platformEntryFromToml(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'auth' && isPlainObject(value)) {
      out[targetKey] = authFromToml(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function authFromToml(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env') {
      out[targetKey] = isPlainObject(value) ? cloneRecord(value) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

export const platformsToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    out[name] = isPlainObject(entry) ? platformEntryToToml(entry, rawSub[name]) : entry;
  }
  return out;
};

function platformEntryToToml(
  platform: Record<string, unknown>,
  rawPlatform: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawPlatform);
  for (const [key, value] of Object.entries(platform)) {
    if (key === 'auth' && isPlainObject(value)) {
      out[camelToSnake(key)] = authToToml(value, out[camelToSnake(key)]);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function authToToml(auth: Record<string, unknown>, rawAuth: unknown): Record<string, unknown> {
  const out = cloneRecord(rawAuth);
  for (const [key, value] of Object.entries(auth)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = plainObjectToToml(value, undefined);
    } else if (key === 'env' && value !== undefined) {
      out[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

registerConfigSection(PLATFORMS_SECTION, PlatformsSectionSchema, {
  defaultValue: {},
  fromToml: platformsFromToml,
  toToml: platformsToToml,
});
