import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

/** Whether a thinking effort represents "thinking enabled" (anything but 'off'). */
export function isThinkingOn(effort: ThinkingEffort): boolean {
  return effort !== 'off';
}

/**
 * Project a thinking effort to the `[thinking]` config patch persisted to
 * config.toml. `'off'` disables thinking; any other effort enables it and
 * records the effort as the global effort preference.
 */
export function thinkingEffortToConfig(effort: ThinkingEffort): {
  enabled: boolean;
  effort?: string;
} {
  return effort === 'off' ? { enabled: false } : { enabled: true, effort: effort };
}
