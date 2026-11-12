/**
 * Thinking configuration: validates a requested effort against the model's thinking metadata, resolves
 * default and forced efforts, and resolves the thinking `keep` value from env and config.
 */
import { ThinkingConfigError } from '#/llm/protocol/errors';
import type {
  LlmModelSpec,
  ModelThinkingMetadata,
  ThinkingEffort,
  ThinkingRequestOptions,
} from '#/llm/request';

export interface ThinkingDefaults {
  readonly enabled?: boolean;
  readonly effort?: string;
}

export type ThinkingResolution =
  | { readonly ok: true; readonly encode: 'silent' }
  | { readonly ok: true; readonly encode: 'effort'; readonly value: string }
  | { readonly ok: false; readonly error: ThinkingConfigError };

function effortList(efforts: readonly string[] | undefined): string | undefined {
  return efforts !== undefined && efforts.length > 0 ? efforts.join(', ') : undefined;
}

export function resolveThinkingEffort(
  options: ThinkingRequestOptions,
  model: LlmModelSpec,
  strictValidation = false,
): ThinkingResolution {
  const effort = options.effort;
  const meta = model.thinking;
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
            ? `Model '${model.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort instead of 'off'.`
            : `Model '${model.name}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (${list}) instead of 'off'.`,
        ),
      };
    }
    if (meta?.supportEfforts !== undefined) {
      return {
        ok: false,
        error: new ThinkingConfigError(
          'off-needs-offeffort',
          `Model '${model.name}' reasons by default but declares no off effort, so thinking cannot be turned off. Declare offEffort (for example 'none') for this model in the model catalog configuration.`,
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
        'effort-unsupported',
        `Model '${model.name}' does not support thinking effort '${effort}'. Supported efforts: ${meta.supportEfforts.join(', ')}. Set the thinking effort to one of the supported values.`,
      ),
    };
  }
  if (meta === undefined && model.capability?.thinking === false) {
    return {
      ok: false,
      error: new ThinkingConfigError(
        'thinking-unsupported',
        `Model '${model.name}' does not support thinking, but thinking effort '${effort}' was requested. Remove the thinking effort setting or choose a thinking-capable model.`,
      ),
    };
  }
  return { ok: true, encode: 'effort', value: effort };
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

export function resolveForcedThinkingEffort(
  forced: string | undefined,
  effective: ThinkingEffort,
  traitDriven: boolean,
): ThinkingEffort | undefined {
  if (!traitDriven || effective === 'off') return undefined;
  return nonEmpty(forced)?.toLowerCase() as ThinkingEffort | undefined;
}

export function modelSupportsThinking(model: LlmModelSpec | undefined): boolean {
  return (
    model?.thinking?.alwaysThinking === true ||
    model?.thinking?.adaptiveThinking === true ||
    model?.capability?.thinking === true
  );
}

export function defaultThinkingEffortForModel(model: LlmModelSpec | undefined): ThinkingEffort {
  if (!modelSupportsThinking(model)) return 'off';
  const efforts = effortsFor(model?.thinking);
  if (efforts.length > 0) {
    const declared = nonEmpty(model?.thinking?.defaultEffort);
    return (declared !== undefined && efforts.includes(declared)
      ? declared
      : middleOf(efforts)) as ThinkingEffort;
  }
  return 'on';
}

export function declaredDefaultEffortForModel(
  model: LlmModelSpec | undefined,
): ThinkingEffort | undefined {
  if (!modelSupportsThinking(model)) return undefined;
  const declared = nonEmpty(model?.thinking?.defaultEffort);
  if (declared === undefined) return undefined;
  return effortsFor(model?.thinking).includes(declared) ? (declared as ThinkingEffort) : undefined;
}

export function modelSupportsThinkingEffort(
  effort: ThinkingEffort,
  model: LlmModelSpec | undefined,
  strictValidation: boolean,
): boolean {
  if (!strictValidation || effort === 'off') return true;
  if (!modelSupportsThinking(model)) return false;
  const efforts = effortsFor(model?.thinking);
  return efforts.length === 0 || effort === 'on' || efforts.includes(effort);
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: LlmModelSpec | undefined,
  strictValidation: boolean,
): ThinkingEffort {
  if (effort === 'off' && model?.thinking?.alwaysThinking !== true) return 'off';
  const efforts = effortsFor(model?.thinking);
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
  model: LlmModelSpec | undefined,
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

  if (effort === 'off' && model?.thinking?.alwaysThinking === true) {
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
