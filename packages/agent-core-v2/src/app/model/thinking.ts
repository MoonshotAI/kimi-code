/**
 * `model` domain (L2) — model-aware thinking effort resolution.
 *
 * Resolves the effective thinking effort from request/config defaults, Kimi's
 * operational wire override, and the model's declared thinking metadata.
 * Shared by `modelResolver` and the Agent-scope `profile` domain so both paths
 * keep v1-compatible defaults.
 */

import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';

export interface ThinkingDefaults {
  readonly enabled?: boolean;
  readonly effort?: string;
}

export interface ModelThinkingMetadata {
  readonly capabilities?: ModelCapability | readonly string[];
  readonly adaptiveThinking?: boolean;
  readonly alwaysThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeRequestedThinkingEffort(
  requested: string | undefined,
): ThinkingEffort | undefined {
  return nonEmpty(requested)?.toLowerCase() as ThinkingEffort | undefined;
}

export function resolveKimiThinkingEffortOverride(
  forced: string | undefined,
  effective: ThinkingEffort,
  kimiProvider: boolean,
): ThinkingEffort | undefined {
  if (!kimiProvider || effective === 'off') return undefined;
  return nonEmpty(forced) as ThinkingEffort | undefined;
}

function hasCapability(
  capabilities: ModelThinkingMetadata['capabilities'],
  capability: string,
): boolean {
  if (capabilities === undefined) return false;
  if (isCapabilityList(capabilities)) {
    return capabilities.some((candidate) => candidate.trim().toLowerCase() === capability);
  }
  switch (capability) {
    case 'thinking':
      return capabilities.thinking;
    case 'always_thinking':
      return false;
    default:
      return false;
  }
}

function isCapabilityList(
  capabilities: ModelThinkingMetadata['capabilities'],
): capabilities is readonly string[] {
  return Array.isArray(capabilities);
}

function middleOf(values: readonly string[]): string {
  return values[Math.floor(values.length / 2)]!;
}

function effortsFor(model: ModelThinkingMetadata | undefined): readonly string[] {
  return model?.supportEfforts?.map(nonEmpty).filter((v): v is string => v !== undefined) ?? [];
}

export function modelSupportsThinking(model: ModelThinkingMetadata | undefined): boolean {
  if (model === undefined) return false;
  return (
    model.alwaysThinking === true ||
    model.adaptiveThinking === true ||
    hasCapability(model.capabilities, 'thinking') ||
    hasCapability(model.capabilities, 'always_thinking')
  );
}

export function defaultThinkingEffortForModel(
  model: ModelThinkingMetadata | undefined,
): ThinkingEffort {
  if (model === undefined || !modelSupportsThinking(model)) return 'off';
  const efforts = effortsFor(model);
  if (efforts.length > 0) {
    const declaredDefault = nonEmpty(model.defaultEffort);
    return (declaredDefault !== undefined && efforts.includes(declaredDefault)
      ? declaredDefault
      : middleOf(efforts)) as ThinkingEffort;
  }
  return 'on';
}

export function modelSupportsThinkingEffort(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  kimiProtocol: boolean,
): boolean {
  if (!kimiProtocol || effort === 'off') return true;
  if (!modelSupportsThinking(model)) return false;
  const efforts = effortsFor(model);
  return efforts.length === 0 || effort === 'on' || efforts.includes(effort);
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: ModelThinkingMetadata | undefined,
  kimiProtocol: boolean,
): ThinkingEffort {
  if (effort === 'off' && model?.alwaysThinking !== true) return 'off';
  const efforts = effortsFor(model);
  if (!kimiProtocol) {
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
  model: ModelThinkingMetadata | undefined,
  kimiProtocol = false,
): ThinkingEffort {
  const configured = nonEmpty(defaults?.effort) as ThinkingEffort | undefined;
  const normalized = normalizeRequestedThinkingEffort(requested);
  let effort: ThinkingEffort;
  if (normalized !== undefined) {
    effort = normalized;
  } else if (defaults?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }

  if (kimiProtocol && effort === 'off' && model?.alwaysThinking === true) {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }
  return normalizeThinkingEffortForModel(effort, model, kimiProtocol);
}
