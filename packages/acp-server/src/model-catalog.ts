/**
 * ACP model catalog — projects agent-core-v2's model configuration registry
 * (`IModelService`) into a flat list of selectable models for the ACP
 * `configOptions` picker.
 *
 * ACP-specific heuristics (thinking-capability derivation, the toggleable-models
 * allow-list) stay scoped to this host. Iteration order mirrors `models`
 * insertion order (Node's `Object.entries` over plain object keys is
 * insertion-ordered for string keys).
 *
 * `thinkingSupported` is true if any of:
 *   1. the model's declared `capabilities` contains `'thinking'`/`'always_thinking'`, or
 *   2. the wire-facing model name matches `/thinking|reason/i`, or
 *   3. the wire-facing model name is on the {@link TOGGLEABLE_THINKING_MODELS}
 *      allow-list.
 */

import type { ModelConfig } from '@moonshot-ai/agent-core-v2';

/**
 * One catalog row per configured model, suitable for an ACP picker.
 */
export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly thinkingSupported: boolean;
  /** Declared 'always_thinking' capability — thinking cannot be turned off. */
  readonly alwaysThinking?: boolean;
  /**
   * The thinking effort to send when the binary ACP toggle flips on: the
   * model's declared `defaultEffort`, else the middle `supportEfforts` entry,
   * else `'on'` for boolean models.
   */
  readonly defaultThinkingEffort: string;
}

/**
 * Models that support thinking by toggle (not by name match or capability
 * declaration). ACP-picker-specific UX.
 */
const TOGGLEABLE_THINKING_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

/** Wire-facing model name used for heuristics/display. */
function modelName(config: ModelConfig): string {
  return config.model ?? config.name ?? '';
}

export function deriveThinkingSupported(config: ModelConfig): boolean {
  const capabilities = config.capabilities ?? [];
  if (capabilities.includes('thinking') || capabilities.includes('always_thinking')) return true;
  const lower = modelName(config).toLowerCase();
  if (lower.includes('thinking') || lower.includes('reason')) return true;
  if (TOGGLEABLE_THINKING_MODELS.has(modelName(config))) return true;
  return false;
}

/**
 * Whether the model declares the 'always_thinking' capability — thinking cannot
 * be disabled, so the ACP toggle must lock to on. Capability-only by design.
 */
export function deriveAlwaysThinking(config: ModelConfig): boolean {
  return (config.capabilities ?? []).includes('always_thinking');
}

/**
 * The effort a boolean "thinking on" toggle maps to for this model: declared
 * `defaultEffort`, else the middle `supportEfforts` entry, else `'on'`.
 */
export function deriveDefaultThinkingEffort(config: ModelConfig): string {
  const efforts = config.supportEfforts;
  if (efforts !== undefined && efforts.length > 0) {
    return config.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

/**
 * Project a model configuration record into a flat ACP catalog. Returns an
 * empty array when no models are configured.
 */
export function projectModelCatalog(
  models: Readonly<Record<string, ModelConfig>>,
): readonly AcpModelEntry[] {
  return Object.entries(models).map(([id, config]) => ({
    id,
    name: config.displayName ?? modelName(config) ?? id,
    thinkingSupported: deriveThinkingSupported(config),
    alwaysThinking: deriveAlwaysThinking(config),
    defaultThinkingEffort: deriveDefaultThinkingEffort(config),
  }));
}
