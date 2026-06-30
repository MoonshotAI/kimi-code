import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

/** Whether a thinking effort represents "thinking enabled" (anything but 'off'). */
export function isThinkingOn(effort: ThinkingEffort): boolean {
  return effort !== 'off';
}

/**
 * Project a thinking effort to the `[thinking]` config patch persisted to
 * config.toml. `'off'` disables thinking; a concrete effort enables thinking
 * and records it as the global effort preference. `'on'` is the boolean-model
 * on-signal rather than a declared effort, so it only persists `enabled` —
 * boolean models resolve back to `'on'` at runtime via `defaultThinkingEffortFor`.
 */
export function thinkingEffortToConfig(effort: ThinkingEffort): {
  enabled: boolean;
  effort?: string;
} {
  if (effort === 'off') return { enabled: false };
  if (effort === 'on') return { enabled: true };
  return { enabled: true, effort };
}
