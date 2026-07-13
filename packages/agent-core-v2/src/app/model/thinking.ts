/**
 * `model` domain (L2) — model-aware thinking effort resolution.
 *
 * Resolves the effective thinking effort from request/config defaults plus the
 * model's declared thinking metadata. Shared by `modelResolver` and the
 * Agent-scope `profile` domain so both paths keep v1-compatible defaults.
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
  const efforts = model.supportEfforts?.map(nonEmpty).filter((v): v is string => v !== undefined);
  if (efforts !== undefined && efforts.length > 0) {
    return (nonEmpty(model.defaultEffort) ?? middleOf(efforts)) as ThinkingEffort;
  }
  return 'on';
}

export function resolveThinkingEffortForModel(
  requested: string | undefined,
  defaults: ThinkingDefaults | undefined,
  model: ModelThinkingMetadata | undefined,
): ThinkingEffort {
  const configured = nonEmpty(defaults?.effort) as ThinkingEffort | undefined;
  const normalized = nonEmpty(requested)?.toLowerCase();
  let effort: ThinkingEffort;
  if (normalized !== undefined) {
    // A requested effort is taken verbatim — including 'on', which is a valid
    // wire value for boolean thinking models. Normalizing 'on' to a concrete
    // effort is the UI boundary's job, not the resolver's (v1 parity).
    effort = normalized as ThinkingEffort;
  } else if (defaults?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortForModel(model);
  }

  if (effort === 'off' && model?.alwaysThinking === true) {
    // always_thinking forces thinking on, but an explicitly configured effort
    // is still honored — `enabled = false` only expresses the intent to
    // disable, it should not also discard a chosen effort. Fall back to the
    // model default only when no effort is configured.
    return configured ?? defaultThinkingEffortForModel(model);
  }
  return effort;
}
