import { pick } from 'radashi';

import type {
  LlmModelSpec,
  LlmRequestModel,
  LlmSampling,
  ResponseFormat,
} from '#/llm/request';

import { SyntaxRequestFormatError } from '../errors';
import type { PassContext } from '../pipeline';
import type { LlmModule, Protocol } from '../protocol';

export function withProtocolCapabilities(
  spec: LlmModelSpec,
  protocol: Pick<Protocol, 'capability'>,
): LlmModelSpec {
  const inferredCapabilities = protocol.capability?.(spec.name);
  if (inferredCapabilities === undefined) return spec;

  const explicitCapabilities = spec.capability;
  return {
    ...spec,
    capability: {
      ...inferredCapabilities,
      ...explicitCapabilities,
    },
  };
}

export interface ModelLegality {
  readonly sampling: readonly (keyof LlmSampling)[];
  readonly responseFormats?: readonly ResponseFormat['type'][];
  readonly clampMaxOutputTokens?: (maxOutputTokens: number, model: LlmModelSpec) => number;
  readonly fillMaxOutputTokens?: (model: LlmModelSpec, usedTokens: number | undefined) => number | undefined;
  readonly verify?: (model: LlmRequestModel, ctx: PassContext) => void;
}

export function legalizeModel(
  module: LlmModule<unknown>,
  legality: ModelLegality,
  keepCacheKey: boolean,
  ctx: PassContext,
): LlmRequestModel {
  const { model } = module;
  const format = model.responseFormat?.type;
  if (format !== undefined && legality.responseFormats !== undefined && !legality.responseFormats.includes(format)) {
    throw new SyntaxRequestFormatError(`The '${format}' response format is not supported by this protocol.`);
  }
  const legal: LlmRequestModel = {
    ...model,
    cacheKey: keepCacheKey ? model.cacheKey : undefined,
    sampling: model.sampling === undefined ? undefined : pick(model.sampling, [...legality.sampling]),
    maxOutputTokens: legalOutputCap(module, legality),
  };
  legality.verify?.(legal, ctx);
  return legal;
}

function legalOutputCap(module: LlmModule<unknown>, legality: ModelLegality): number | undefined {
  const { maxOutputTokens, spec } = module.model;
  if (maxOutputTokens === 'none') return undefined;
  const { usedTokens } = module.content;
  const explicit = maxOutputTokens === undefined || maxOutputTokens <= 0 ? undefined : maxOutputTokens;
  const requested = explicit ?? legality.fillMaxOutputTokens?.(spec, usedTokens);
  if (requested === undefined) return undefined;
  const window = spec.maxContextSize;
  const room =
    window === undefined || window <= 0 || usedTokens === undefined ? requested : window - usedTokens;
  const cap = Math.max(1, Math.min(requested, room));
  return legality.clampMaxOutputTokens?.(cap, spec) ?? cap;
}
