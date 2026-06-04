/**
 * ACP model catalog — adapter-local helper that turns the harness's
 * config snapshot into a flat list of selectable models for the ACP
 * `configOptions` picker (`packages/acp-adapter/src/config-options.ts`).
 *
 * Used to live inside `@moonshot-ai/kimi-code-sdk` as
 * `KimiHarness.listAvailableModels()`; moved here so the SDK keeps a
 * minimal surface and ACP-specific heuristics (thinking-capability
 * derivation, the toggleable-models allow-list) stay scoped to the
 * adapter.
 *
 * Iteration order mirrors `config.models` insertion order — Node's
 * `Object.entries` over plain object keys is insertion-ordered for
 * string keys, matching the Python reference's
 * `for model_key, model in models.items()`.
 *
 * `thinkingSupported` is true if any of:
 *   1. the alias's declared `capabilities` array contains `'thinking'`, or
 *   2. the underlying model name matches `/thinking|reason/i`
 *      (always-thinking variants), or
 *   3. the underlying model name is on the {@link TOGGLEABLE_THINKING_MODELS}
 *      allow-list (mirrors `kimi-cli/src/kimi_cli/llm.py:derive_model_capabilities`).
 */

import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

/**
 * One catalog row per configured model alias, suitable for an ACP
 * picker. `description` is left optional so the harness can populate it
 * later without breaking callers; ACP UIs treat it as a flavour-text
 * subtitle.
 */
export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly thinkingSupported: boolean;
}

/**
 * Models that support thinking by toggle (not by name match or
 * `capabilities` declaration). Kept here because the list is
 * ACP-picker-specific UX — moving it into the kernel would bake an
 * adapter concern into a place that doesn't need to know about ACP.
 */
const TOGGLEABLE_THINKING_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

export function deriveThinkingSupported(alias: ModelAlias): boolean {
  const declared = alias.capabilities ?? [];
  if (declared.includes('thinking')) return true;
  const lower = alias.model.toLowerCase();
  if (lower.includes('thinking') || lower.includes('reason')) return true;
  if (TOGGLEABLE_THINKING_MODELS.has(alias.model)) return true;
  return false;
}

/**
 * Project `harness.getConfig().models` into a flat catalog. Returns an
 * empty array when the harness has no models configured, when
 * `getConfig` is missing on the harness (partial test stubs), or when
 * `getConfig` throws — letting the caller decide how to surface a
 * degenerate config without forcing every test stub to provide every
 * field.
 */
export async function listModelsFromHarness(
  harness: KimiHarness,
): Promise<readonly AcpModelEntry[]> {
  if (typeof harness.getConfig !== 'function') return [];
  let models: Record<string, ModelAlias> | undefined;
  try {
    const config = await harness.getConfig();
    models = config.models;
  } catch {
    return [];
  }
  if (models === undefined) return [];
  const out: AcpModelEntry[] = [];
  for (const [id, alias] of Object.entries(models)) {
    out.push({
      id,
      name: alias.displayName ?? alias.model ?? id,
      thinkingSupported: deriveThinkingSupported(alias),
    });
  }
  return out;
}
