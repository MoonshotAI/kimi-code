import type { ThinkingEffort } from '@moonshot-ai/kosong';

import type { ThinkingConfig } from '../../config/schema';

export type { ThinkingEffort };

const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

const THINKING_EFFORTS = new Set<ThinkingEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Resolve the effective default effort for a model: the declared
 * `default_effort` when present, otherwise the middle entry of
 * `support_efforts` (so we never hardcode a level the model does not support).
 * Returns undefined when the model declares no efforts at all.
 */
export function effectiveDefaultEffort(model: {
  readonly defaultEffort?: string | undefined;
  readonly supportEfforts?: readonly string[] | undefined;
}): string | undefined {
  if (model.defaultEffort !== undefined) return model.defaultEffort;
  const efforts = model.supportEfforts;
  if (efforts !== undefined && efforts.length > 0) {
    return efforts[Math.floor(efforts.length / 2)];
  }
  return undefined;
}

export interface ResolveThinkingLevelOptions {
  readonly defaultThinking?: boolean | undefined;
  readonly thinking?: ThinkingConfig | undefined;
  /** Model-declared default effort (catalog `default_effort`). Used as a
   * fallback when the global `thinking.effort` is unset or invalid. */
  readonly modelDefaultEffort?: string | undefined;
}

export function resolveThinkingLevel(
  requestedThinking: string | undefined,
  options: ResolveThinkingLevelOptions,
): ThinkingEffort {
  const resolvedRequest =
    requestedThinking !== undefined && requestedThinking.trim().length > 0
      ? requestedThinking
      : options.defaultThinking === false
        ? 'off'
        : undefined;

  return resolveThinkingEffort(resolvedRequest, options.thinking, options.modelDefaultEffort);
}

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
  modelDefaultEffort?: string,
): ThinkingEffort {
  // Global thinking.effort wins when it is a valid effort; otherwise fall back
  // to the model's declared default_effort; the hardcoded 'high' is the final
  // safety net when neither is usable.
  const configEffort =
    parseEffort(defaults?.effort) ?? parseEffort(modelDefaultEffort) ?? DEFAULT_THINKING_EFFORT;
  const normalized = requested?.trim().toLowerCase();
  if (!normalized) {
    if (defaults?.mode === 'off') return 'off';
    return configEffort;
  }
  if (normalized === 'off') return 'off';
  if (normalized === 'on') return configEffort;
  return parseEffort(normalized) ?? configEffort;
}

function parseEffort(value: string | undefined): ThinkingEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && THINKING_EFFORTS.has(normalized as ThinkingEffort)
    ? (normalized as ThinkingEffort)
    : undefined;
}
