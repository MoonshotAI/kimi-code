import type { ContentPart } from '#/app/llmProtocol/message';

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

export type HookFailMode = 'open' | 'closed';

export interface HookDef {
  readonly event: HookEventType;
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
  readonly failMode?: HookFailMode;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export interface HookResult {
  readonly action: 'allow' | 'block';
  readonly message?: string;
  readonly reason?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly structuredOutput?: boolean;
}

export interface HookBlockDecision {
  readonly block: true;
  readonly reason: string;
}

export type HookMatcherValue = string | readonly ContentPart[];
