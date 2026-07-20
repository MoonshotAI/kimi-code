import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

/** Whether a thinking effort represents "thinking enabled" (anything but 'off'). */
export function isThinkingOn(effort: ThinkingEffort): boolean {
  return effort !== 'off';
}

/**
 * Project a thinking effort to the `[thinking]` config patch persisted to
 * config.toml. `'off'` disables thinking; `'on'` is the boolean-model
 * on-signal rather than a declared effort, so it only persists `enabled` —
 * boolean models resolve back to `'on'` at runtime via
 * `defaultThinkingEffortFor`. A concrete effort persists as the global
 * default, EXCEPT the model's highest declared level — the last entry of
 * `support_efforts` (the list is ordered by strength, the same assumption
 * the `middleOf` default-effort resolution makes) — which is session-only
 * and records just `enabled`, so the most expensive tier never becomes the
 * global default for every new session. When the model's levels are unknown
 * the concrete effort is persisted as-is.
 */
export function thinkingEffortToConfig(
  effort: ThinkingEffort,
  supportEfforts?: readonly string[],
): {
  enabled: boolean;
  effort?: string;
} {
  if (effort === 'off') return { enabled: false };
  if (effort === 'on') return { enabled: true };
  const top = supportEfforts?.at(-1);
  if (top !== undefined && effort === top) return { enabled: true };
  return { enabled: true, effort };
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
