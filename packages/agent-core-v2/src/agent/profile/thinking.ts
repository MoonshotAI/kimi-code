/**
 * `profile` domain — thinking-level resolution helpers.
 *
 * Resolves the effective `ThinkingEffort` from a requested level, the
 * `thinking` config section (`ThinkingConfig`, owned here in `profile`), and
 * the `defaultThinking` toggle. Pure functions; own no scoped state.
 */

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import {
  type ModelThinkingMetadata,
  resolveThinkingEffortForModel,
} from '#/app/model/thinking';

import type { ThinkingConfig } from './configSection';

export interface ResolveThinkingLevelOptions {
  readonly defaultThinking?: boolean;
  readonly thinking?: ThinkingConfig;
  readonly model?: ModelThinkingMetadata;
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

  return resolveThinkingEffort(resolvedRequest, options.thinking, options.model);
}

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
  model?: ModelThinkingMetadata,
): ThinkingEffort {
  return resolveThinkingEffortForModel(requested, defaults, model);
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
