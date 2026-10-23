import { pick } from 'radashi';

import type {
  LlmModelSpec,
  LlmRequestModel,
  LlmSampling,
} from '#/llm/request';
import type { ResponseFormat } from '#/llm/response-format';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';
import type { ThinkingEffort, ThinkingRequestOptions } from '#/llm/thinking';

import type { PassContext } from '../pipeline';
import type { LlmModule, Protocol } from '../protocol';

export function effectiveModelSpec(
  protocol: Pick<Protocol, 'capability'>,
  spec: LlmModelSpec,
): LlmModelSpec {
  const inferred = protocol.capability?.(spec.name);
  if (inferred === undefined) return spec;
  return { ...spec, capability: { ...inferred, ...spec.capability } };
}

export interface ModelLegality {
  readonly sampling: readonly (keyof LlmSampling)[];
  readonly responseFormats?: readonly ResponseFormat['type'][];
  readonly strictThinkingEfforts?: boolean;
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
    thinking: legality.strictThinkingEfforts === true ? strictThinking(model.thinking, model.spec) : model.thinking,
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

function strictThinking(
  thinking: ThinkingRequestOptions | undefined,
  spec: LlmModelSpec,
): ThinkingRequestOptions | undefined {
  if (thinking === undefined) return undefined;
  const effort = strictEffort(thinking.effort, spec);
  return effort === thinking.effort ? thinking : { ...thinking, effort };
}

function strictEffort(effort: ThinkingEffort, spec: LlmModelSpec): ThinkingEffort {
  const meta = spec.thinking;
  if (effort === 'off' && meta?.alwaysThinking !== true) return 'off';
  if (meta?.alwaysThinking !== true && meta?.adaptiveThinking !== true && spec.capability?.thinking !== true) {
    return 'off';
  }
  const efforts = meta?.supportEfforts?.map((value) => value.trim()).filter((value) => value.length > 0) ?? [];
  if (efforts.length === 0) return 'on';
  if (effort !== 'on' && efforts.includes(effort)) return effort;
  const declared = meta?.defaultEffort?.trim();
  return declared !== undefined && efforts.includes(declared)
    ? declared
    : efforts[Math.floor(efforts.length / 2)]!;
}
