import { isUnknownCapability, type ModelCapability } from '#/llm/capability';
import type { LlmErrorMessage } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';

export type ThinkingEffort = 'off' | 'on' | (string & {});

export interface ThinkingRequestOptions {
  readonly effort: ThinkingEffort;
  readonly keep?: string;
}

export interface ModelThinkingMetadata {
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly adaptiveThinking?: boolean;
}

export interface ThinkingDefaults {
  readonly enabled?: boolean;
  readonly effort?: string;
}

export type ThinkingConfigErrorCode =
  | 'effort-not-supported'
  | 'thinking-unsupported'
  | 'thinking-cannot-disable'
  | 'off-needs-offeffort';

export class ThinkingConfigError extends SyntaxRequestFormatError {
  readonly code: ThinkingConfigErrorCode;

  constructor(code: ThinkingConfigErrorCode, message: string) {
    super(message);
    this.name = 'ThinkingConfigError';
    this.code = code;
  }

  override toLlmErrorMessage(): LlmErrorMessage<'syntax'> {
    return { kind: 'syntax', code: 'thinking_config', message: this.message };
  }
}

export type ThinkingResolution =
  | { readonly ok: true; readonly encode: 'silent' }
  | { readonly ok: true; readonly encode: 'effort'; readonly value: string }
  | { readonly ok: false; readonly error: ThinkingConfigError };

export function thinkingMetadataOf(model: LlmModel): ModelThinkingMetadata | undefined {
  const candidate = model as LlmModel & ModelThinkingMetadata;
  const { supportEfforts, defaultEffort, offEffort, alwaysThinking, adaptiveThinking } = candidate;
  if (
    supportEfforts === undefined &&
    defaultEffort === undefined &&
    offEffort === undefined &&
    alwaysThinking === undefined &&
    adaptiveThinking === undefined
  ) {
    return undefined;
  }
  return { supportEfforts, defaultEffort, offEffort, alwaysThinking, adaptiveThinking };
}

function capabilityThinking(capability: ModelCapability): boolean | undefined {
  return isUnknownCapability(capability) ? undefined : capability.thinking;
}

function effortList(efforts: readonly string[] | undefined): string | undefined {
  return efforts !== undefined && efforts.length > 0 ? efforts.join(', ') : undefined;
}

export function resolveThinkingEffort(
  options: ThinkingRequestOptions,
  model: LlmModel,
  strictValidation = false,
): ThinkingResolution {
  const effort = options.effort;
  const meta = thinkingMetadataOf(model);
  if (effort === 'on') {
    return { ok: true, encode: 'silent' };
  }
  if (effort === 'off') {
    if (meta?.offEffort !== undefined) {
      return { ok: true, encode: 'effort', value: meta.offEffort };
    }
    if (meta?.alwaysThinking === true) {
      const list = effortList(meta.supportEfforts);
      return {
        ok: false,
        error: new ThinkingConfigError(
          'thinking-cannot-disable',
          list === undefined
            ? `Model '${model.model}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort instead of 'off'.`
            : `Model '${model.model}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (${list}) instead of 'off'.`,
        ),
      };
    }
    if (meta?.supportEfforts !== undefined) {
      return {
        ok: false,
        error: new ThinkingConfigError(
          'off-needs-offeffort',
          `Model '${model.model}' reasons by default but declares no off effort, so thinking cannot be turned off. Declare offEffort (for example 'none') for this model in the model catalog configuration.`,
        ),
      };
    }
    return { ok: true, encode: 'silent' };
  }
  if (
    strictValidation &&
    meta?.supportEfforts !== undefined &&
    !meta.supportEfforts.includes(effort)
  ) {
    return {
      ok: false,
      error: new ThinkingConfigError(
        'effort-not-supported',
        `Model '${model.model}' does not support thinking effort '${effort}'. Supported efforts: ${meta.supportEfforts.join(', ')}. Set the thinking effort to one of the supported values.`,
      ),
    };
  }
  if (meta === undefined && capabilityThinking(model.capability) === false) {
    return {
      ok: false,
      error: new ThinkingConfigError(
        'thinking-unsupported',
        `Model '${model.model}' does not support thinking, but thinking effort '${effort}' was requested. Remove the thinking effort setting or choose a thinking-capable model.`,
      ),
    };
  }
  return { ok: true, encode: 'effort', value: effort };
}

export function encodeReasoningEffortFallback(
  thinking: ThinkingRequestOptions,
  model: LlmModel,
  strictValidation = false,
): Record<string, unknown> | undefined {
  const resolution = resolveThinkingEffort(thinking, model, strictValidation);
  if (!resolution.ok) throw resolution.error;
  return resolution.encode === 'effort' ? { reasoning_effort: resolution.value } : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function middleOf(values: readonly string[]): string {
  return values[Math.floor(values.length / 2)]!;
}

function effortsFor(meta: ModelThinkingMetadata | undefined): readonly string[] {
  return meta?.supportEfforts?.map(nonEmpty).filter((v): v is string => v !== undefined) ?? [];
}

export function normalizeRequestedThinkingEffort(
  requested: string | undefined,
): ThinkingEffort | undefined {
  return nonEmpty(requested)?.toLowerCase() as ThinkingEffort | undefined;
}

export function modelSupportsThinking(model: LlmModel): boolean {
  const meta = thinkingMetadataOf(model);
  return (
    meta?.alwaysThinking === true ||
    meta?.adaptiveThinking === true ||
    capabilityThinking(model.capability) === true
  );
}

export function defaultThinkingEffortForModel(model: LlmModel): ThinkingEffort {
  const meta = thinkingMetadataOf(model);
  if (!modelSupportsThinking(model)) return 'off';
  const efforts = effortsFor(meta);
  if (efforts.length > 0) {
    const declared = nonEmpty(meta?.defaultEffort);
    return (declared !== undefined && efforts.includes(declared)
      ? declared
      : middleOf(efforts)) as ThinkingEffort;
  }
  return 'on';
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: LlmModel,
  strictValidation: boolean,
): ThinkingEffort {
  const meta = thinkingMetadataOf(model);
  if (effort === 'off' && meta?.alwaysThinking !== true) return 'off';
  const efforts = effortsFor(meta);
  if (!strictValidation) {
    return effort === 'on' && efforts.length > 0
      ? defaultThinkingEffortForModel(model)
      : effort;
  }
  if (!modelSupportsThinking(model)) return 'off';
  if (efforts.length === 0) return 'on';
  if (effort === 'on' || !efforts.includes(effort)) {
    return defaultThinkingEffortForModel(model);
  }
  return effort;
}

export function resolveThinkingEffortForModel(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: LlmModel,
  strictValidation = false,
): ThinkingEffort {
  const configured = normalizeRequestedThinkingEffort(defaults?.effort);
  const normalized = normalizeRequestedThinkingEffort(requested);
  let effort: ThinkingEffort;
  if (normalized !== undefined) {
    effort = normalized;
  } else if (defaults?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }

  if (effort === 'off' && thinkingMetadataOf(model)?.alwaysThinking === true) {
    effort =
      configured !== undefined && configured !== 'off'
        ? configured
        : defaultThinkingEffortForModel(model);
  }
  return normalizeThinkingEffortForModel(effort, model, strictValidation);
}

const KEEP_OFF_VALUES = new Set(['0', 'false', 'no', 'off', 'none', 'null']);

type KeepResolution =
  | { readonly specified: false }
  | { readonly specified: true; readonly value: string | undefined };

function parseKeepValue(raw: string | undefined): KeepResolution {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { specified: false };
  if (KEEP_OFF_VALUES.has(trimmed.toLowerCase())) return { specified: true, value: undefined };
  return { specified: true, value: trimmed };
}

export function resolveThinkingKeep(
  envKeep: string | undefined,
  configKeep: string | undefined,
  thinkingEffort: ThinkingEffort,
): string | undefined {
  if (thinkingEffort === 'off') return undefined;
  const fromEnv = parseKeepValue(envKeep);
  if (fromEnv.specified) return fromEnv.value;
  const fromConfig = parseKeepValue(configKeep);
  if (fromConfig.specified) return fromConfig.value;
  return 'all';
}
