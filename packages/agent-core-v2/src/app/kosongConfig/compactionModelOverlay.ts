import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { isPlainObject } from '#/app/config/toml';
import type { ModelOverride } from '#/kosong/model/model';

import {
  COMPACTION_MODEL_SECTION,
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  type CompactionModelConfig,
} from './configSection';

export const COMPACTION_DERIVED_MODEL_ID = '__compaction__';

export function compactionModelPatch(
  compaction: CompactionModelConfig | undefined,
): ModelOverride | undefined {
  if (compaction === undefined) return undefined;
  const {
    model: _model,
    defaultModel: _defaultModel,
    secondaryModel: _secondaryModel,
    ...patch
  } = compaction;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function withoutKey(value: unknown, key: string): unknown {
  if (!isPlainObject(value) || !(key in value)) return value;
  const out: Record<string, unknown> = { ...value };
  delete out[key];
  return out;
}

export const compactionModelOverlay: ConfigEffectiveOverlay = {
  apply(effective, _getEnv, validate) {
    const compaction = effective[COMPACTION_MODEL_SECTION] as
      | CompactionModelConfig
      | undefined;
    const patch = compactionModelPatch(compaction);
    const baseId = compaction?.model;
    if (
      patch === undefined ||
      baseId === undefined ||
      baseId === COMPACTION_DERIVED_MODEL_ID
    ) {
      return [];
    }
    const models = asRecord(effective[MODELS_SECTION]);
    const base = models[baseId];
    if (!isPlainObject(base)) return [];
    const { overrides: baseOverrides, aliases: _aliases, ...baseFields } = base;
    const derived: Record<string, unknown> = {
      ...baseFields,
      overrides: { ...asRecord(baseOverrides), ...patch },
    };
    effective[MODELS_SECTION] = validate(MODELS_SECTION, {
      ...models,
      [COMPACTION_DERIVED_MODEL_ID]: derived,
    });
    return [MODELS_SECTION];
  },

  strip(domain, value, rawSnake) {
    switch (domain) {
      case MODELS_SECTION:
        return withoutKey(value, COMPACTION_DERIVED_MODEL_ID);
      case DEFAULT_MODEL_SECTION:
        if (value !== COMPACTION_DERIVED_MODEL_ID) return value;
        return typeof rawSnake['default_model'] === 'string'
          ? rawSnake['default_model']
          : undefined;
      default:
        return value;
    }
  },
};

registerConfigOverlay(compactionModelOverlay);
