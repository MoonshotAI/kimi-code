/**
 * `profile` domain — thinking-effort resolution helpers.
 *
 * Resolves the effective `ThinkingEffort` from a requested effort and the
 * `thinking` config section (`ThinkingConfig`, owned here in `profile`).
 * Pure functions; own no scoped state.
 */

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import {
  modelSupportsThinkingEffort,
  type ModelThinkingMetadata,
  resolveThinkingEffortForModel,
} from '#/app/model/thinking';

import type { ThinkingConfig } from './configSection';

type ThinkingModel = ModelThinkingMetadata & {
  readonly protocol?: string;
  readonly providerType?: string;
};

function usesKimiThinkingSemantics(model: ThinkingModel | undefined): boolean {
  return model?.protocol === 'kimi';
}

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
  model?: ThinkingModel,
): ThinkingEffort {
  return resolveThinkingEffortForModel(requested, defaults, model, usesKimiThinkingSemantics(model));
}

export function supportsThinkingEffort(
  effort: ThinkingEffort,
  model: ThinkingModel | undefined,
): boolean {
  return modelSupportsThinkingEffort(effort, model, usesKimiThinkingSemantics(model));
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
