import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
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

export type VisualModelChoice = 'primary' | 'visual';

export function resolveVisualModel(
  config: IConfigService,
  flags: IFlagService,
): VisualModelConfig | undefined {
  if (!flags.enabled(VISUAL_MODEL_FLAG_ID)) return undefined;
  return config.get<VisualModelConfig | undefined>(VISUAL_MODEL_SECTION);
}

export function resolveVisualBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: VisualModelChoice,
  overrides?: { visualAlias?: string },
): { model: string; thinking?: string; displayModel: string } {
  const overrideAlias = overrides?.visualAlias;
  if (overrideAlias !== undefined) {
    return {
      model: overrideAlias,
      displayModel: visualDisplayModel(config, overrideAlias),
    };
  }
  const visual = resolveVisualModel(config, flags);
  const pointer = visual?.model ?? visual?.defaultModel;
  if (requested !== 'primary' && visual !== undefined && pointer !== undefined) {
    const model =
      visualModelPatch(visual) === undefined ? pointer : VISUAL_DERIVED_MODEL_ID;
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

export const VISUAL_MODEL_CHOICE_SCHEMA = z.enum(['primary', 'visual']);
