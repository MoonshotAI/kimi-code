import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

/** Whether a thinking level represents "thinking enabled" (anything but 'off'). */
export function isThinkingOn(level: ThinkingEffort): boolean {
  return level !== 'off';
}

/**
 * Project a thinking level to the `[thinking]` config patch persisted to
 * config.toml. `'off'` disables thinking; any other level enables it and
 * records the level as the global effort preference.
 */
export function thinkingEffortToConfig(level: ThinkingEffort): {
  enabled: boolean;
  effort?: string;
} {
  return level === 'off' ? { enabled: false } : { enabled: true, effort: level };
}
