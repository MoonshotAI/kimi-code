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

export const ALL_TIPS: readonly ToolbarTip[] = [
  { text: 'shift+tab: plan mode' },
  { text: '/model: switch model' },
  { text: 'ctrl+s: steer mid-turn', priority: 2 },
  { text: 'ctrl+b: background task', priority: 2 },
  { text: '/compact: compact context', priority: 2 },
  { text: 'ctrl+o: expand tool output' },
  { text: 'ctrl+t: expand todo list' },
  { text: '/tasks: background tasks' },
  { text: 'shift+enter: newline' },
  { text: '/init: generate AGENTS.md', priority: 2 },
  { text: '@: mention files' },
  { text: 'ctrl+c: cancel' },
  { text: '/theme: switch theme' },
  { text: '/auto: auto permission mode' },
  { text: '/yolo: toggle yolo' },
  { text: '/help: show commands' },
  { text: '/dance: rainbow mode, because why not' },
  { text: '/plugins: manage plugins — try the "superpowers" plugin', solo: true, priority: 3 },
  { text: 'ask Kimi to schedule tasks, e.g. "remind me at 5pm"', solo: true, priority: 3 },
];
