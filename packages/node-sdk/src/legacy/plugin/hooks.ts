/**
 * External lifecycle hook types — the engine's wire contract is the source
 * of truth (`@moonshot-ai/kimi-agent/rpc/wire` → `rpc/types.rs`), so
 * `HookEventType` / `HookDef` re-export the generated wire types. The
 * runtime `HOOK_EVENT_TYPES` array is kept locally (the generated module
 * carries types only) and satisfies the wire union.
 */

import type { HookEventType } from '@moonshot-ai/kimi-agent/rpc/wire';

export type { HookDef, HookEventType } from '@moonshot-ai/kimi-agent/rpc/wire';

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
] as const satisfies readonly HookEventType[];
