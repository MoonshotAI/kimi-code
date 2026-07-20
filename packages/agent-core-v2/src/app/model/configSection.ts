/**
 * `model` domain (L2) — `models` config-section TOML transforms.
 *
 * Snake_case ↔ camelCase transforms that preserve user-defined alias names
 * (record keys) while converting each alias's fields. Self-registered at module
 * load via `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 */

import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';

import { MODELS_SECTION, ModelsSectionSchema } from './model';

export const modelsFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [alias, entry] of Object.entries(rawSnake)) {
    if (!isPlainObject(entry)) {
      out[alias] = entry;
      continue;
    }
    const converted = transformPlainObject(entry);
    if (isPlainObject(converted['overrides'])) {
      converted['overrides'] = transformPlainObject(converted['overrides']);
    }
    out[alias] = converted;
  }
  return out;
};

export const modelsToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [alias, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[alias] = entry;
      continue;
    }
    const rawEntry = cloneRecord(rawSub[alias]);
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
    out[alias] = { ...rawEntry, ...converted };
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
