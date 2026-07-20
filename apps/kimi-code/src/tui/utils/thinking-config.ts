import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

/** Whether a thinking effort represents "thinking enabled" (anything but 'off'). */
export function isThinkingOn(effort: ThinkingEffort): boolean {
  return effort !== 'off';
}

/**
 * Effort levels eligible for persistence to config.toml, on the canonical
 * scale `low/medium/high/xhigh/max`. `max` and any level outside the scale
 * (custom provider-declared names) are session-only: they work at runtime but
 * only the boolean toggle is persisted, so the most expensive tier never
 * becomes the global default for every new session.
 */
export const PERSISTABLE_THINKING_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * Project a thinking effort to the `[thinking]` config patch persisted to
 * config.toml. `'off'` disables thinking; `'on'` is the boolean-model
 * on-signal rather than a declared effort, so it only persists `enabled` —
 * boolean models resolve back to `'on'` at runtime via
 * `defaultThinkingEffortFor`. A concrete effort persists as the global default
 * when it is in {@link PERSISTABLE_THINKING_EFFORTS}; anything above it is
 * session-only and only `enabled` is recorded.
 */
export function thinkingEffortToConfig(effort: ThinkingEffort): {
  enabled: boolean;
  effort?: string;
} {
  if (effort === 'off') return { enabled: false };
  if (effort === 'on') return { enabled: true };
  if (PERSISTABLE_THINKING_EFFORTS.includes(effort)) return { enabled: true, effort };
  return { enabled: true };
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
