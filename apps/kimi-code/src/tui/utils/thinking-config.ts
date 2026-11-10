import type { ModelAlias, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

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
 * default, EXCEPT when it ranks above the model's effective default
 * effort: `support_efforts` is ordered by strength (the same assumption
 * the `middleOf` default-effort resolution makes), and a pick more
 * expensive than the default stays session-only and records just
 * `enabled`, so it never becomes the global default for every new
 * session. The default here is the effective model's, however it arose —
 * declared via the catalog or `[models.*.overrides]`, or synthesized by
 * the protocol-profile inference (`withAnthropicProfile` resolves Claude
 * models to 'high', so an 'xhigh' pick stays session-only there). When
 * the effective model carries no default effort at all, its highest
 * declared level stays session-only (the historical rule). Undeclared
 * values persist as-is — the configured provider validates them.
 */
export function thinkingEffortToConfig(
  effort: ThinkingEffort,
  model?: Pick<ModelAlias, 'supportEfforts' | 'defaultEffort'>,
): {
  enabled: boolean;
  effort?: string;
} {
  if (effort === 'off') return { enabled: false };
  if (effort === 'on') return { enabled: true };
  const efforts = model?.supportEfforts;
  if (efforts !== undefined && efforts.includes(effort)) {
    const declared = model?.defaultEffort;
    const ceiling =
      declared !== undefined && efforts.includes(declared)
        ? efforts.indexOf(declared)
        : efforts.length - 2;
    if (efforts.indexOf(effort) > ceiling) return { enabled: true };
  }
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
