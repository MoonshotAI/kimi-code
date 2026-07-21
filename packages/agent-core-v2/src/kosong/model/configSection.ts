/**
 * `kosong/model` domain (L2) — `models` config-section TOML transforms.
 *
 * Snake_case ↔ camelCase transforms that preserve user-defined model ids
 * (record keys) while converting each id's fields. Self-registered at module
 * load via `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 *
 * Side-effect module: production gets it from the `src/index.ts`
 * side-effect block; tests import it on demand. This module is the sole
 * owner of the section — the legacy `app/model/configSection` is gone.
 *
 * Note: the `app/config` imports below are deliberately RELATIVE paths — see
 * `modelService.ts` for the rationale.
 */

import { registerConfigSection } from '../../app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '../../app/config/toml';

import { MODELS_SECTION, ModelsSectionSchema } from './model';

export const modelsFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(rawSnake)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const converted = transformPlainObject(entry);
    if (isPlainObject(converted['overrides'])) {
      converted['overrides'] = transformPlainObject(converted['overrides']);
    }
    out[id] = converted;
  }
  return out;
};

export const modelsToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const rawEntry = cloneRecord(rawSub[id]);
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
    out[id] = { ...rawEntry, ...converted };
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
