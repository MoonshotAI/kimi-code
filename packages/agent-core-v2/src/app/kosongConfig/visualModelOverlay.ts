
import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { isPlainObject } from '#/app/config/toml';
import type { ModelOverride } from '#/kosong/model/model';

import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  VISUAL_MODEL_SECTION,
  type VisualModelConfig,
} from './configSection';

export const VISUAL_DERIVED_MODEL_ID = '__visual__';

export function visualModelPatch(
  visual: VisualModelConfig | undefined,
): ModelOverride | undefined {
  if (visual === undefined) return undefined;
  const { model: _model, defaultModel: _defaultModel, ...patch } = visual;
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

export const visualModelOverlay: ConfigEffectiveOverlay = {
  apply(effective, _getEnv, validate) {
    const visual = effective[VISUAL_MODEL_SECTION] as VisualModelConfig | undefined;
    const patch = visualModelPatch(visual);
    const baseId = visual?.model;
    if (patch === undefined || baseId === undefined || baseId === VISUAL_DERIVED_MODEL_ID) {
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
      [VISUAL_DERIVED_MODEL_ID]: derived,
    });
    return [MODELS_SECTION];
  },

  strip(domain, value, rawSnake) {
    switch (domain) {
      case MODELS_SECTION:
        return withoutKey(value, VISUAL_DERIVED_MODEL_ID);
      case DEFAULT_MODEL_SECTION:
        if (value !== VISUAL_DERIVED_MODEL_ID) return value;
        return typeof rawSnake['default_model'] === 'string'
          ? rawSnake['default_model']
          : undefined;
      default:
        return value;
    }
  },
};

registerConfigOverlay(visualModelOverlay);
