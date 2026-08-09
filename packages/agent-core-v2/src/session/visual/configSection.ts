/**
 * `visual` domain — visual-model config-section resolver.
 *
 * Visual-model mirror of {@link ../../../session/subagent/configSection}:
 * resolves which model handles image / screenshot / video inspection tasks
 * when the `visual-model` experiment is enabled and `[visual_model]` is
 * configured. The caller's model remains the default; the visual model is
 * an opt-in override for vision-only work, parallel to how the secondary
 * model is an opt-in override for subagent spawns.
 *
 * Resolution rules (mirror of `resolveSubagentBinding`):
 *  - When the experiment is disabled, or `[visual_model]` is unset, returns
 *    `undefined` from {@link resolveVisualModel} and the caller's own model
 *    from {@link resolveVisualBinding} — no behavior change.
 *  - When set, {@link resolveVisualModel} returns the configured recipe; a
 *    recipe with patch fields binds the synthesized derived entry
 *    ({@link VISUAL_DERIVED_MODEL_ID}, materialized by `visualModelOverlay`);
 *    a pointer-only recipe binds the pointed entry directly. `default_effort`
 *    is passed as the explicit visual-task thinking effort; without it the
 *    visual task resolves thinking naturally (global thinking config → the
 *    bound model's default effort) rather than inheriting the caller's level.
 *
 * The TUI / agent tool descriptions can surface the pair via
 * {@link buildVisualModelDescriptions} (each line suffixed with the entry's
 * resolved capability flags, so the parent can route multimodal or
 * thinking-heavy visual tasks instead of guessing from the model id), and
 * spawn failures are wrapped with {@link wrapVisualModelError} so a missing
 * visual-model alias points back at `[visual_model].model` /
 * `KIMI_VISUAL_MODEL`. While the experiment is off, the no-op `model`
 * parameter (when a tool chooses to advertise one for visual selection) is
 * stripped via {@link stripVisualModelParameter}. Display-facing alias
 * resolution goes through {@link visualDisplayModel}: the derived entry id
 * means nothing to a user, so it resolves back to the recipe's base alias —
 * flag-independent on purpose, since interpreting an already-persisted
 * derived binding (resume) must keep working after the experiment is
 * switched off.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { isPlainObject } from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  VISUAL_MODEL_ENV,
  VISUAL_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  VISUAL_DERIVED_MODEL_ID,
  visualModelPatch,
} from '#/app/kosongConfig/visualModelOverlay';
import { type VisualModelConfig } from '#/app/kosongConfig/configSection';
import type { IConfigService } from '#/app/config/config';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { VISUAL_MODEL_FLAG_ID } from './flag';

export type VisualModelChoice = AgentModelPreference;

export function resolveVisualModel(
  config: IConfigService,
  flags: IFlagService,
): VisualModelConfig | undefined {
  if (!flags.enabled(VISUAL_MODEL_FLAG_ID)) return undefined;
  return config.get<VisualModelConfig | undefined>(VISUAL_MODEL_SECTION);
}

/**
 * Resolve which model handles a visual (image / screenshot / video)
 * inspection task. `own` is the caller's current model state, used when
 * inheriting (visual model unset or explicit `primary` request).
 *
 * `requested` mirrors the subagent `model` parameter: `undefined` follows the
 * default (visual model when set, caller's model otherwise); `'primary'`
 * forces the caller's model even when a visual model is configured; a
 * visual-model-aware tool can also accept `'visual'` to force the visual
 * model when configured (returns the caller's model when no visual model is
 * configured, so the symbolic choice never fails).
 */
export function resolveVisualBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: VisualModelChoice,
): { model: string; thinking?: string; displayModel: string } {
  const visual = resolveVisualModel(config, flags);
  if (requested !== 'primary' && visual?.model !== undefined) {
    const model =
      visualModelPatch(visual) === undefined ? visual.model : VISUAL_DERIVED_MODEL_ID;
    return {
      model,
      thinking: visual.defaultEffort,
      displayModel: visualDisplayModel(config, model),
    };
  }
  return {
    model: own.modelAlias,
    thinking: own.thinkingLevel,
    displayModel: visualDisplayModel(config, own.modelAlias),
  };
}

export function visualDisplayModel(config: IConfigService, boundAlias: string): string {
  if (boundAlias !== VISUAL_DERIVED_MODEL_ID) return boundAlias;
  return (
    config.get<VisualModelConfig | undefined>(VISUAL_MODEL_SECTION)?.model ?? boundAlias
  );
}

/**
 * The "Available models" block appended to visual-task tool descriptions so
 * the parent model knows it can pick. `undefined` when the visual model is
 * not configured or the caller's model is not bound yet.
 */
export function buildVisualModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
  modelCatalog: IModelCatalog,
): string | undefined {
  const visual = resolveVisualModel(config, flags);
  const visualModel = visual?.model;
  if (visualModel === undefined || callerModelAlias === undefined) return undefined;
  const boundVisual =
    visualModelPatch(visual) === undefined ? visualModel : VISUAL_DERIVED_MODEL_ID;
  return [
    'Available models for visual inspection (pass via model):',
    `- visual: ${visualModel} (default) — the configured visual model; prefer it for image / screenshot / video inspection${capabilitiesSuffix(resolvedCapabilities(modelCatalog, boundVisual))}`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it when the caller is itself vision-capable and you want to keep the work in-process${capabilitiesSuffix(resolvedCapabilities(modelCatalog, callerModelAlias))}`,
  ].join('\n');
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(capability: ModelCapability | undefined): string {
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

function resolvedCapabilities(
  modelCatalog: IModelCatalog,
  model: string,
): ModelCapability | undefined {
  try {
    return modelCatalog.get(model).capabilities;
  } catch {
    return undefined;
  }
}

/**
 * Strip the `model` property from a visual-task tool's advertised JSON schema.
 * While the `visual-model` experiment is off the parameter is a silent no-op,
 * so the schema the model sees (and the args validator compiled from the same
 * advertised schema) drops it entirely — the visual-model concept never
 * enters the prompt, and a stray `model` argument is rejected instead of
 * silently inheriting the caller's model. Returns the input unchanged when
 * there is no `model` property; otherwise a shallow copy — the input is never
 * mutated, so callers can keep both variants as shared constants.
 */
export function stripVisualModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

/**
 * Point a visual-task model resolution failure at the visual-model
 * configuration when the bound model is not the caller's own — otherwise the
 * parent model sees a bare "model not configured" error with no hint that it
 * comes from `[visual_model]`.
 */
export function wrapVisualModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === VISUAL_DERIVED_MODEL_ID
      ? `the derived entry "${VISUAL_DERIVED_MODEL_ID}"`
      : `"${boundModel}"`;
  return new Error2(
    error.code,
    `${error.message} (visual model ${displayModel} comes from [visual_model].model / ${VISUAL_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        visualModel: boundModel,
        visualModelConfig: {
          section: 'visualModel.model',
          environment: VISUAL_MODEL_ENV,
        },
      },
    },
  );
}

// Re-export the schema symbol for tests / type-only consumers that want a
// single import surface for the visual domain. The schema itself lives next
// to the other kosong config sections (see `kosongConfig/configSection.ts`).
export const VISUAL_MODEL_CHOICE_SCHEMA = z.enum(['primary', 'visual']);
