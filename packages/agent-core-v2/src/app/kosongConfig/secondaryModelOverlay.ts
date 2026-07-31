/**
 * `kosongConfig` domain — `[secondary_model]` derived-entry overlay.
 *
 * When the secondary-model recipe carries patch fields, synthesizes the
 * derived registry entry (`SECONDARY_DERIVED_MODEL_ID`) into the effective
 * `models` view: a copy of the pointed entry with the patch merged into its
 * `overrides` block (patch wins conflicts) and `aliases` dropped, so the
 * derived entry never competes in name/alias routing. Subagent binding then
 * resolves it by name through the standard catalog path, and the patch rides
 * the same `effectiveModelConfig` merge as any `models.*.overrides`
 * (including its supportEfforts/defaultEffort pruning and input clamping).
 *
 * Like the env overlay, the synthesized entry lives ONLY in the in-memory
 * effective view: `strip` removes it from `models` writes so it never
 * reaches `config.toml`, and the persistence bridge's deep-equal guards keep
 * the two-way sync silent. `strip` also rolls back a `defaultModel` pointer
 * set to the derived id (restoring the raw value, mirroring the env
 * overlay's pinned-pointer handling) — the pointer can never dangle on disk
 * after the recipe is removed. Nothing is synthesized when the recipe has no
 * patch fields (subagents bind the pointed entry directly), when
 * `secondary.model` is unset, or when the pointed entry does not exist (the
 * warning service reports the dangling pointer; spawn fails with the wrapped
 * error). The id is reserved: a user-configured entry under it is stripped
 * on write all the same.
 *
 * Self-registered at module load via `registerConfigOverlay`; it is imported
 * for side effects after the env overlay, so a `secondary.model` pointing at
 * the env-synthesized entry sees the already-applied env view.
 */

import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { isPlainObject } from '#/app/config/toml';
import type { ModelOverride } from '#/kosong/model/model';

import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  SECONDARY_MODEL_SECTION,
  type SecondaryModelConfig,
} from './configSection';

export const SECONDARY_DERIVED_MODEL_ID = '__secondary__';

export function secondaryModelPatch(
  secondary: SecondaryModelConfig | undefined,
): ModelOverride | undefined {
  if (secondary === undefined) return undefined;
  const { model: _model, ...patch } = secondary;
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

export const secondaryModelOverlay: ConfigEffectiveOverlay = {
  apply(effective, _getEnv, validate) {
    const secondary = effective[SECONDARY_MODEL_SECTION] as SecondaryModelConfig | undefined;
    const patch = secondaryModelPatch(secondary);
    const baseId = secondary?.model;
    if (patch === undefined || baseId === undefined || baseId === SECONDARY_DERIVED_MODEL_ID) {
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
      [SECONDARY_DERIVED_MODEL_ID]: derived,
    });
    return [MODELS_SECTION];
  },

  strip(domain, value, rawSnake) {
    switch (domain) {
      case MODELS_SECTION:
        return withoutKey(value, SECONDARY_DERIVED_MODEL_ID);
      case DEFAULT_MODEL_SECTION:
        if (value !== SECONDARY_DERIVED_MODEL_ID) return value;
        return typeof rawSnake['default_model'] === 'string'
          ? rawSnake['default_model']
          : undefined;
      default:
        return value;
    }
  },
};

registerConfigOverlay(secondaryModelOverlay);
