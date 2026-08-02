/**
 * External lifecycle hook types — local port of the retired
 * `agent-core/session/hooks` surface. Hooks run at engine lifecycle
 * boundaries (PreToolUse / UserPromptSubmit / Stop ...); the engine executes
 * them natively, hosts contribute them from config + plugins.
 */

export const HOOK_EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export interface HookDef {
  readonly event: HookEventType;
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}
