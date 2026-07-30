export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: 'ctrl-s to add guidance without waiting for the turn to finish', priority: 2, solo: true },
  { text: '/tasks to check progress and status for background tasks', priority: 2 },
  { text: '/init: generate AGENTS.md', priority: 2 },
  { text: 'Try /dance for a hidden Easter egg' },
  {
    text: '/plugins: manage plugins — try the "Kimi Datasource" for reliable financial, economic, and academic data',
    solo: true,
    priority: 3,
  },
  { text: 'ask Kimi to schedule tasks, e.g. "remind me at 5pm"', solo: true, priority: 3 },
  { text: '/sessions to browse and resume earlier sessions', solo: true },
  { text: '/goal for multi-step work with a clear finish line', priority: 2, solo: true  },
  { text: '/goal next to queue follow-up work while the current goal keeps running', solo: true },
  { text: '/web: use the Web UI for a better experience', solo: true },
  { text: '@: mention files', priority: 2 },
  { text: '! to run a shell command', priority: 2 },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: 'shift+enter: newline' },
  { text: 'ctrl+c: cancel' },
  { text: '/theme to switch the terminal UI theme' },
  { text: '/auto when you want Kimi to handle approvals and keep going unattended' },
  { text: '/yolo to skip most approvals for trusted batch work, only use it in repos you trust' },
  { text: '/help: show commands' },
  { text: '/compact compresses context when it gets long', priority: 2 },
  { text: 'ctrl-o to hide or reveal tool output switching between a clean chat view and full execution details', priority: 2 },
  { text: 'shift-tab to Plan mode to review the approach before Kimi edits files.', priority: 2 },
  { text: '/model: switch model', priority: 2 },
];

/**
 * Custom tips ("spinner verbs") from `[tips]` in tui.toml.
 *
 * `append` (default) mixes user tips into the built-in rotation; `replace`
 * shows only user tips (Claude Code `spinnerVerbs` parity). Consumers read
 * the effective lists via `getWorkingTips()` / `getAllTips()` and memoize
 * against `tipsConfigVersion()`, which bumps on every effective change.
 */
export type TipsMode = 'append' | 'replace';

let customTips: readonly ToolbarTip[] = [];
let customMode: TipsMode = 'append';
let version = 0;

export function configureCustomTips(mode: TipsMode, tips: readonly string[]): void {
  const normalized = tips
    .map((t) => ({ text: t.trim() }))
    .filter((t) => t.text.length > 0);
  const unchanged =
    mode === customMode &&
    normalized.length === customTips.length &&
    normalized.every((t, i) => t.text === customTips[i]!.text);
  if (unchanged) return;
  customMode = mode;
  customTips = normalized;
  version += 1;
}

export function tipsConfigVersion(): number {
  return version;
}

/**
 * The currently configured custom tips, for code paths that re-serialize
 * tui.toml (e.g. `/config` saves) and must not drop the user's `[tips]`.
 */
export function getCustomTipsConfig(): { mode: TipsMode; custom: string[] } {
  return { mode: customMode, custom: customTips.map((t) => t.text) };
}

export function getWorkingTips(): readonly ToolbarTip[] {
  if (customMode === 'replace' && customTips.length > 0) return customTips;
  return [...WORKING_TIPS, ...customTips];
}

export function getAllTips(): readonly ToolbarTip[] {
  if (customMode === 'replace' && customTips.length > 0) return customTips;
  return [...ALL_TIPS, ...customTips];
}
