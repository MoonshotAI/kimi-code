import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import {
  COMPACTION_MODEL_ENV,
  COMPACTION_MODEL_SECTION,
  type CompactionModelConfig,
} from '#/app/kosongConfig/configSection';
import {
  COMPACTION_DERIVED_MODEL_ID,
  compactionModelPatch,
} from '#/app/kosongConfig/compactionModelOverlay';

import { COMPACTION_MODEL_FLAG_ID } from './flag';

export { COMPACTION_DERIVED_MODEL_ID };

/**
 * `compaction` domain — compaction-model config-section resolver.
 *
 * Compaction-model mirror of {@link ../../../session/visual/configSection}:
 * resolves which model handles context compaction when the `compaction-model`
 * experiment is enabled and `[compaction_model]` is configured. The active
 * conversation model remains the default; the compaction model is an opt-in
 * override for the summarization/compaction step, parallel to how the visual
 * model is an opt-in override for visual inspection tasks.
 *
 * Resolution rules (mirror of `resolveVisualModel` / `resolveVisualBinding`):
 *  - When the experiment is disabled, or `[compaction_model]` is unset, returns
 *    `undefined` from {@link resolveCompactionModel} and the caller's own model
 *    from {@link resolveCompactionBinding} — no behavior change.
 *  - When set, {@link resolveCompactionModel} returns the configured recipe; a
 *    recipe with patch fields binds the synthesized derived entry
 *    ({@link COMPACTION_DERIVED_MODEL_ID}, materialized by
 *    `compactionModelOverlay`); a pointer-only recipe binds the pointed entry
 *    directly. `default_effort` is passed as the explicit compaction thinking
 *    effort; without it the compaction step resolves thinking naturally (global
 *    thinking config → the bound model's default effort) rather than inheriting
 *    the caller's level.
 *
 * The caller resolves a binding via {@link compactionModelBindingFor}: a helper
 * that returns the dedicated compaction model when configured, or the caller's
 * own model otherwise. When the dedicated model errors or is inaccessible, the
 * caller transparently retries the same round on its own model — the dedicated
 * model is a best-effort override, never a hard dependency. Display-facing
 * alias resolution goes through {@link compactionDisplayModel}: the derived
 * entry id means nothing to a user, so it resolves back to the recipe's base
 * alias.
 */
export interface CompactionBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}

export function resolveCompactionModel(
  config: IConfigService,
  flags: IFlagService,
): CompactionModelConfig | undefined {
  if (!flags.enabled(COMPACTION_MODEL_FLAG_ID)) return undefined;
  return config.get<CompactionModelConfig | undefined>(COMPACTION_MODEL_SECTION);
}

/**
 * Resolve which model handles a compaction round. `own` is the caller's current
 * model state, used when inheriting (compaction model unset). Returns the
 * dedicated compaction model when configured, otherwise the caller's own model.
 */
export function resolveCompactionBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
): CompactionBinding {
  const compaction = resolveCompactionModel(config, flags);
  // `model` is the engine-contract pointer; `defaultModel` is the legacy
  // field an older TUI wrote — honored as a fallback so those configs start
  // working instead of staying dead. `model` wins when both are set.
  const pointer = compaction?.model ?? compaction?.defaultModel;
  if (compaction !== undefined && pointer !== undefined) {
    const model =
      compactionModelPatch(compaction) === undefined
        ? pointer
        : COMPACTION_DERIVED_MODEL_ID;
    return {
      model,
      thinking: compaction.defaultEffort,
      displayModel: compactionDisplayModel(config, model),
    };
  }
  return {
    model: own.modelAlias,
    thinking: own.thinkingLevel,
    displayModel: compactionDisplayModel(config, own.modelAlias),
  };
}

/**
 * Convenience wrapper around {@link resolveCompactionBinding} that fails back to
 * the caller's own model when the compaction model is not configured. The
 * dedicated model is never a hard requirement: callers treat the returned
 * binding as a best-effort override and retry on their own model on error.
 */
export function compactionModelBindingFor(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
): CompactionBinding {
  return resolveCompactionBinding(config, flags, own);
}

export function compactionDisplayModel(config: IConfigService, boundAlias: string): string {
  if (boundAlias !== COMPACTION_DERIVED_MODEL_ID) return boundAlias;
  return (
    config.get<CompactionModelConfig | undefined>(COMPACTION_MODEL_SECTION)?.model ?? boundAlias
  );
}

/**
 * Point a compaction-model resolution failure at `[compaction_model]` when the
 * bound model is not the caller's own — otherwise the caller sees a bare
 * "model not configured" error with no hint that it comes from the compaction
 * model configuration. Used by callers to wrap a dedicated-model error before
 * falling back to the current model.
 */
export function wrapCompactionModelError(error: unknown, boundModel: string): unknown {
  if (boundModel === COMPACTION_DERIVED_MODEL_ID) {
    return new Error(
      `Compaction model "${boundModel}" from [compaction_model] / ${COMPACTION_MODEL_ENV} is not a valid [models] entry`,
      { cause: error },
    );
  }
  return error;
}
