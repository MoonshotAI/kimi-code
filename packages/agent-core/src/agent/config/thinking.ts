import type { ThinkingEffort } from '@moonshot-ai/kosong';

import type { ThinkingConfig } from '../../config/schema';

export type { ThinkingEffort };

const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

const THINKING_EFFORTS = new Set<ThinkingEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

export interface ResolveThinkingLevelOptions {
  readonly defaultThinking?: boolean | undefined;
  readonly thinking?: ThinkingConfig | undefined;
}

export function resolveThinkingLevel(
  requestedThinking: string | undefined,
  options: ResolveThinkingLevelOptions,
): ThinkingEffort {
  const resolvedRequest =
    requestedThinking !== undefined && requestedThinking.length > 0
      ? requestedThinking
      : options.defaultThinking === false
        ? 'off'
        : undefined;

  return resolveThinkingEffort(resolvedRequest, options.thinking);
}

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
): ThinkingEffort {
  const configEffort = parseEffort(defaults?.effort) ?? DEFAULT_THINKING_EFFORT;
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
