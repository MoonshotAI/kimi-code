/**
 * `kosongConfig` domain — `[visual_model]` derived-entry overlay.
 *
 * Visual-model mirror of {@link secondaryModelOverlay}: when the
 * visual-model recipe carries patch fields, synthesizes the derived registry
 * entry ({@link VISUAL_DERIVED_MODEL_ID}) into the effective `models` view —
 * a copy of the pointed entry with the patch merged into its `overrides`
 * block (patch wins conflicts) and `aliases` dropped, so the derived entry
 * never competes in name/alias routing. Visual-task model binding then
 * resolves it by name through the standard catalog path, and the patch rides
 * the same `effectiveModelConfig` merge as any `models.*.overrides`
 * (including its `supportEfforts` / `defaultEffort` pruning and input
 * clamping).
 *
 * Like the env overlay and the secondary-model overlay, the synthesized entry
 * lives ONLY in the in-memory effective view: `strip` removes it from
 * `models` writes so it never reaches `config.toml`, and the persistence
 * bridge's deep-equal guards keep the two-way sync silent. `strip` also rolls
 * back a `defaultModel` pointer set to the derived id (restoring the raw
 * value, mirroring the secondary-model overlay's pinned-pointer handling) —
 * the pointer can never dangle on disk after the recipe is removed. Nothing
 * is synthesized when the recipe has no patch fields (visual tasks bind the
 * pointed entry directly), when `visual.model` is unset, or when the pointed
 * entry does not exist. The id is reserved: a user-configured entry under it
 * is stripped on write all the same.
 *
 * Self-registered at module load via `registerConfigOverlay`; it is imported
 * for side effects after the secondary-model overlay so a `visual.model`
 * pointing at the secondary-derived entry sees the already-applied secondary
 * view, and a `secondary.model` pointing at the visual-derived entry sees
 * the already-applied visual view.
 */

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
  const { model: _model, ...patch } = visual;
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
