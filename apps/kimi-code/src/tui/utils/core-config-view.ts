/**
 * Typed structural views over the v2 resolved config (`CoreConfig`).
 *
 * The v2 config surface (`IConfigService.getAll()`) is domain-keyed and untyped
 * (`Record<string, unknown>`). The TUI reads a handful of domains (`models`,
 * `providers`, `defaultModel`, `thinking`) whose shapes are validated at load
 * time by the section schemas the engine registers (e.g. `ThinkingConfigSchema`
 * in `agent-core-v2/src/agent/profile/configSection.ts`). These helpers narrow
 * those domains to the v1 structural shapes the TUI (and the oauth refresh
 * adapter) still consume, so call sites stay free of `as unknown as` casts and
 * index-signature access.
 */

import type { CoreConfig, ModelAlias, ProviderConfig } from '#/core/index';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `models` domain: alias-name → `ModelAlias`. */
export function modelsView(config: CoreConfig): Record<string, ModelAlias> {
  const value = config['models'];
  return isRecord(value) ? (value as Record<string, ModelAlias>) : {};
}

/** `providers` domain: provider-name → `ProviderConfig`. */
export function providersView(config: CoreConfig): Record<string, ProviderConfig> {
  const value = config['providers'];
  return isRecord(value) ? (value as Record<string, ProviderConfig>) : {};
}

/** `defaultModel` domain: the selected alias name, when configured. */
export function defaultModelView(config: CoreConfig): string | undefined {
  const value = config['defaultModel'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `thinking` domain view, projected onto the v1 `{ enabled?, effort? }` shape
 * that {@link import('./thinking-config').thinkingEffortFromConfig} consumes.
 *
 * The v2 section schema keys the toggle as `mode: 'auto' | 'on' | 'off'`
 * (`ThinkingConfigSchema`), while v1 used `enabled: boolean`.
 * `thinkingEffortFromConfig` treats `enabled === false` as the "off" signal,
 * so this view maps `mode === 'off'` → `enabled: false` (and any other
 * present mode → `enabled: true`) to preserve that helper's semantics. The
 * concrete `effort` string is passed through unchanged.
 */
export function thinkingView(
  config: CoreConfig,
): { enabled?: boolean; effort?: string } | undefined {
  const value = config['thinking'];
  if (!isRecord(value)) return undefined;
  const mode = value['mode'];
  const effort = value['effort'];
  // Prefer the v2 `mode` toggle; fall back to a v1-style `enabled` boolean so
  // configs that have not been rewritten yet (and older test fixtures) still
  // honor the "off" signal.
  const enabled =
    mode === 'off'
      ? false
      : mode === 'on' || mode === 'auto'
        ? true
        : typeof value['enabled'] === 'boolean'
          ? (value['enabled'] as boolean)
          : undefined;
  return {
    enabled,
    effort: typeof effort === 'string' && effort.length > 0 ? effort : undefined,
  };
}
