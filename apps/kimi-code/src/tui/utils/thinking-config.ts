import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

/** Whether a thinking effort represents "thinking enabled" (anything but 'off'). */
export function isThinkingOn(effort: ThinkingEffort): boolean {
  return effort !== 'off';
}

/**
 * Project a thinking effort to the `[thinking]` config patch persisted to
 * config.toml. Only the boolean `enabled` flag is persisted — picking a model
 * or thinking mode in the TUI no longer records the concrete effort. Boolean
 * models resolve back to `'on'` at runtime via `defaultThinkingEffortFor`, and
 * effort-capable models fall back to their own default effort.
 */
export function thinkingEffortToConfig(effort: ThinkingEffort): {
  enabled: boolean;
} {
  return { enabled: effort !== 'off' };
}

/**
 * Inverse of {@link thinkingEffortToConfig}: derive the runtime thinking effort
 * to activate a model with from the persisted `[thinking]` config. Returns
 * `'off'` when thinking is disabled, the configured concrete effort when set,
 * and `undefined` when thinking is enabled without a concrete effort so the
 * model's own default applies.
 */
export function thinkingEffortFromConfig(
  config: { enabled?: boolean; effort?: string } | undefined,
): ThinkingEffort | undefined {
  if (config?.enabled === false) return 'off';
  return config?.effort;
}
