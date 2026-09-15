/**
 * ACP model catalog — projects the engine's model catalog (`IModelCatalog`,
 * surfaced through `klient.global.kosong.listModels()`) into a flat list of
 * selectable models for the ACP `configOptions` picker.
 *
 * ACP-specific heuristics (thinking-capability derivation, the toggleable-models
 * allow-list) stay scoped to this host. Order mirrors the catalog's
 * enumeration order (the engine's model-registry insertion order).
 *
 * `thinkingSupported` is true if any of:
 *   1. the model's declared `capabilities` contains `'thinking'`/`'always_thinking'`, or
 *   2. the model id matches `/thinking|reason/i`, or
 *   3. the model id is on the {@link TOGGLEABLE_THINKING_MODELS} allow-list.
 */

import type { ModelCatalogItem } from '@moonshot-ai/klient';

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
  /**
   * The model's declared selectable effort levels (`support_efforts`).
   * `undefined` when the model only exposes a boolean thinking toggle.
   */
  readonly supportEfforts?: readonly string[];
}

/**
 * Models that support thinking by toggle (not by name match or capability
 * declaration). ACP-picker-specific UX.
 */
const TOGGLEABLE_THINKING_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

export function deriveThinkingSupported(item: ModelCatalogItem): boolean {
  const capabilities = item.capabilities ?? [];
  if (capabilities.includes('thinking') || capabilities.includes('always_thinking')) return true;
  const lower = item.model.toLowerCase();
  if (lower.includes('thinking') || lower.includes('reason')) return true;
  if (TOGGLEABLE_THINKING_MODELS.has(item.model)) return true;
  return false;
}

/**
 * Whether the model declares the 'always_thinking' capability — thinking cannot
 * be disabled, so the ACP toggle must lock to on. Capability-only by design.
 */
export function deriveAlwaysThinking(item: ModelCatalogItem): boolean {
  return (item.capabilities ?? []).includes('always_thinking');
}

/**
 * The effort a boolean "thinking on" toggle maps to for this model: declared
 * `default_effort`, else the middle `support_efforts` entry, else `'on'`.
 */
export function deriveDefaultThinkingEffort(item: ModelCatalogItem): string {
  const efforts = item.support_efforts;
  if (efforts !== undefined && efforts.length > 0) {
    return item.default_effort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

/**
 * Project the engine's model catalog into a flat ACP catalog. Returns an empty
 * array when no models are configured. The catalog item's `model` field is the
 * model-registry id — the value `agent.setModel()` takes — so it doubles as
 * the ACP picker value.
 */
export function projectModelCatalog(
  items: readonly ModelCatalogItem[],
): readonly AcpModelEntry[] {
  return items.map((item) => ({
    id: item.model,
    name: item.display_name ?? item.model,
    thinkingSupported: deriveThinkingSupported(item),
    alwaysThinking: deriveAlwaysThinking(item),
    defaultThinkingEffort: deriveDefaultThinkingEffort(item),
    supportEfforts:
      item.support_efforts !== undefined && item.support_efforts.length > 0
        ? item.support_efforts
        : undefined,
  }));
}
