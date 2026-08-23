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

/**
 * `kosongConfig` domain — `[compaction_model]` derived-entry overlay.
 *
 * Compaction-model mirror of {@link visualModelOverlay}: when the
 * compaction-model recipe carries patch fields, synthesizes the derived
 * registry entry ({@link COMPACTION_DERIVED_MODEL_ID}) into the effective
 * `models` view — a copy of the pointed entry with the patch merged into its
 * `overrides` block (patch wins conflicts) and `aliases` dropped, so the
 * derived entry never competes in name/alias routing. Compaction-model binding
 * then resolves it by name through the standard catalog path, and the patch
 * rides the same `effectiveModelConfig` merge as any `models.*.overrides`
 * (including its `supportEfforts` / `defaultEffort` pruning and input
 * clamping).
 *
 * The synthesized entry lives ONLY in the in-memory effective view: `strip`
 * removes it from `models` writes so it never reaches `config.toml`, and the
 * persistence bridge's deep-equal guards keep the two-way sync silent. `strip`
 * also rolls back a `defaultModel` pointer set to the derived id (restoring the
 * raw value). Nothing is synthesized when the recipe has no patch fields (when
 * `compaction.model` is unset), or when the pointed entry does not exist. The
 * id is reserved: a user-configured entry under it is stripped on write all the
 * same.
 *
 * Self-registered at module load via `registerConfigOverlay`; it is imported
 * for side effects after the visual-model overlay.
 */
export const COMPACTION_DERIVED_MODEL_ID = '__compaction__';

export function compactionModelPatch(
  compaction: CompactionModelConfig | undefined,
): ModelOverride | undefined {
  if (compaction === undefined) return undefined;
  // `model` and the legacy `defaultModel` pointer are not patch fields —
  // stripping both keeps a pointer-only config patch-free so it binds the
  // pointed entry directly instead of synthesizing the derived override.
  const { model: _model, defaultModel: _defaultModel, ...patch } = compaction;
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
