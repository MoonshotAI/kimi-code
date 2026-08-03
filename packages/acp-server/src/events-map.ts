import { isAbsolute } from 'node:path';

import type {
  AvailableCommand,
  PlanEntry,
  PlanEntryStatus,
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolInputDisplay,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndReason,
} from '@moonshot-ai/protocol';

import { displayBlockToAcpContent, toolResultToAcpContent } from './convert';
import type { AcpStopReason } from './types';

/**
 * Build an ACP `session/update` notification with an
 * `agent_message_chunk` payload from an `assistant.delta` event.
 */
export function assistantDeltaToSessionUpdate(
  sessionId: string,
  event: AssistantDeltaEvent,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: event.delta },
    },
  };
}

/**
 * Map a {@link TurnEndReason} to an ACP `stopReason`.
 *
 * `completed` → `end_turn`: the model finished a clean turn.
 * `cancelled` → `cancelled`: the client/agent cancelled mid-turn.
 * `failed`    → `end_turn` (with the out-of-band `error` logged by the
 *   caller). ACP's `StopReason` has no dedicated `failed` variant in this
 *   protocol version, and the spec discourages signaling errors through
 *   `stopReason` (errors belong on the JSON-RPC error channel).
 * `failed` + `provider.filtered` → `refusal`: the provider's safety policy
 *   blocked the response.
 * `blocked`   → `refusal`: a prompt hook blocked the turn before the model
 *   ran. ACP has no separate hook-blocked terminal state, so reuse the
 *   refusal channel.
 */
export function turnEndReasonToStopReason(
  reason: TurnEndReason,
  error?: { readonly code: string },
): AcpStopReason {
  switch (reason) {
    case 'completed':
      return 'end_turn';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      if (error?.code === 'provider.filtered') return 'refusal';
      return 'end_turn';
    case 'blocked':
      return 'refusal';
  }
}

/** Error codes that indicate an authentication / authorization failure. */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider.auth_error',
  'auth.login_required',
  'auth.token_missing',
  'auth.token_unauthorized',
  'auth.provisioning_required',
  'auth.model_not_resolved',
]);

/**
 * Whether the given error (from a `turn.ended` event) is an auth failure that
 * should surface as a JSON-RPC `auth_required` error so the ACP client
 * triggers its re-auth flow.
 */
export function isAuthError(error?: { readonly code: string }): boolean {
  return error !== undefined && AUTH_ERROR_CODES.has(error.code);
}

/**
 * Build the ACP `toolCallId` for a wire-level tool call.
 *
 * Composes `${turnId}:${toolCallId}` so multiple turns within a single
 * session (which legitimately reuse the same model-assigned tool call id
 * when the model retries) do not collide on the ACP side. The raw
 * `toolCallId` remains the in-process accumulator key — only the ACP wire
 * id is prefixed.
 */
export function acpToolCallId(turnId: number, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

/**
 * Heuristic map from a Kimi tool's `name` to ACP {@link ToolKind}.
 *
 * Pure, never throws — defaults to `'other'` whenever the name is
 * unrecognized so we never block streaming on an unknown tool.
 */
export function inferToolKind(name: string): ToolKind {
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';
    case 'Write':
    case 'Edit':
      return 'edit';
    case 'Bash':
    case 'Terminal':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'Think':
      return 'think';
    default:
      return 'other';
  }
}

/**
 * Best-effort JSON stringification for tool args. Never throws — a streaming
 * push must never crash the prompt loop.
 */
export function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/**
 * File tools whose raw args carry a path worth advertising as a location.
 * v2 tools use `path`; `file_path` is accepted too for legacy-style args.
 */
const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

function argsPath(name: string, args: unknown): string | undefined {
  if (!FILE_TOOL_NAMES.has(name) || typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Derive the ACP {@link ToolCallLocation}s for a tool call, best-effort.
 *
 * Priority: the display block's path (diff / file_io — the same display data
 * `displayBlockToAcpContent` reads), then the raw args of the known file
 * tools. Only absolute paths are advertised (the wire contract requires
 * them); when nothing qualifies the caller omits the field rather than
 * fabricating one. No line information exists in either source, so `line`
 * stays unset.
 */
export function toolCallLocations(
  name: string,
  args: unknown,
  display: ToolInputDisplay | undefined,
): ToolCallLocation[] | undefined {
  const displayPath =
    display !== undefined && (display.kind === 'diff' || display.kind === 'file_io')
      ? display.path
      : undefined;
  const path = [displayPath, argsPath(name, args)].find(
    (candidate): candidate is string => candidate !== undefined && isAbsolute(candidate),
  );
  if (path === undefined) return undefined;
  return [{ path }];
}

/**
 * Build the ACP `session/update` for the **initial** `tool_call` create
 * notification from a `tool.call.started` event.
 */
export function toolCallStartToSessionUpdate(
  sessionId: string,
  event: ToolCallStartedEvent,
): SessionNotification {
  const title = event.description ?? event.name;
  const content: ToolCallContent[] = [
    {
      type: 'content',
      content: { type: 'text', text: stringifyArgs(event.args) },
    },
  ];
  // If the tool attached a diff-bearing display, prepend an inline diff entry
  // so the client can render it alongside the textual args preview.
  if (event.display) {
    const diff = displayBlockToAcpContent(event.display);
    if (diff !== null) {
      content.unshift(diff);
    }
  }
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      title,
      kind: inferToolKind(event.name),
      status: 'in_progress',
      rawInput: event.args,
      locations: toolCallLocations(event.name, event.args, event.display),
      content,
    },
  };
}

/**
 * Build a `tool_call_update` for a streaming arguments delta. Mutates
 * `accumulator.args` with the new fragment and emits cumulative REPLACE
 * content.
 */
export function toolCallDeltaToSessionUpdate(
  sessionId: string,
  event: ToolCallDeltaEvent,
  accumulator: { args: string },
): SessionNotification {
  accumulator.args += event.argumentsPart ?? '';
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      status: 'in_progress',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: accumulator.args },
        },
      ],
    },
  };
}

/**
 * Build the initial ACP `tool_call` (CREATE) notification from the **first**
 * `tool.call.delta` event for a given `toolCallId`.
 *
 * agent-core-v2 emits `tool.call.delta` events while the provider streams the
 * model's tool-call args, and only later emits `tool.call.started` (after the
 * streaming phase, when the call is dispatched). Lazy-creating the wire
 * tool_call from the first delta gives subsequent deltas a legitimate parent
 * to update, so the client never sees an update before its create.
 */
export function toolCallLazyCreateToSessionUpdate(
  sessionId: string,
  event: ToolCallDeltaEvent,
): SessionNotification {
  const name = event.name ?? 'tool';
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      title: name,
      kind: event.name ? inferToolKind(event.name) : 'other',
      status: 'pending',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: event.argumentsPart ?? '' },
        },
      ],
    },
  };
}

/**
 * Build a `tool_call_update` that finalises a lazy-created tool call once
 * `tool.call.started` arrives. Used only when
 * {@link toolCallLazyCreateToSessionUpdate} already emitted a `tool_call` for
 * this `toolCallId` from a streaming delta — we cannot send a second CREATE,
 * so the canonical metadata is delivered as an update instead.
 */
export function toolCallStartedUpgradeToSessionUpdate(
  sessionId: string,
  event: ToolCallStartedEvent,
): SessionNotification {
  const title = event.description ?? event.name;
  const content: ToolCallContent[] = [
    {
      type: 'content',
      content: { type: 'text', text: stringifyArgs(event.args) },
    },
  ];
  if (event.display) {
    const diff = displayBlockToAcpContent(event.display);
    if (diff !== null) {
      content.unshift(diff);
    }
  }
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      title,
      kind: inferToolKind(event.name),
      status: 'in_progress',
      rawInput: event.args,
      locations: toolCallLocations(event.name, event.args, event.display),
      content,
    },
  };
}

/**
 * Map a `tool.progress` event to an ACP `tool_call_update`. Only
 * `update.kind === 'status'` with non-empty `text` produces a notification
 * (refreshes the tool card title); everything else returns `null`.
 */
export function toolProgressToSessionUpdate(
  sessionId: string,
  event: ToolProgressEvent,
): SessionNotification | null {
  if (event.update.kind === 'status' && event.update.text) {
    return {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: acpToolCallId(event.turnId, event.toolCallId),
        title: event.update.text,
      },
    };
  }
  return null;
}

/**
 * Map a `thinking.delta` event to an `agent_thought_chunk` notification.
 */
export function thinkingDeltaToSessionUpdate(
  sessionId: string,
  event: ThinkingDeltaEvent,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: event.delta },
    },
  };
}

/**
 * Map a `tool.result` event to the **terminal** `tool_call_update`
 * notification for that call. `status` flips to `completed` (success) or
 * `failed` (`event.isError === true`); content replaces the streaming args
 * preview with the final tool output; `rawOutput` preserves the raw output.
 * `ToolResultEvent` carries no args/display, so `locations` (derived at
 * `tool.call.started` by the caller) is re-attached here when available.
 */
export function toolResultToSessionUpdate(
  sessionId: string,
  event: ToolResultEvent,
  locations?: ToolCallLocation[],
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      status: event.isError ? 'failed' : 'completed',
      content: toolResultToAcpContent(event),
      rawOutput: event.output,
      locations,
    },
  };
}

/**
 * Translate a TodoList display block into an ACP `plan` session update.
 * `done` rewrites to `completed`; `priority` defaults to `'medium'`. Returns
 * `null` for an empty items array.
 */
export function todoListToSessionUpdate(
  sessionId: string,
  turnId: number,
  items: ReadonlyArray<{ title: string; status: string }>,
): SessionNotification | null {
  void turnId;
  if (items.length === 0) return null;
  const entries: PlanEntry[] = items.map((item) => ({
    content: item.title,
    priority: 'medium',
    status: mapTodoStatus(item.status),
  }));
  return {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries,
    },
  };
}

function mapTodoStatus(status: string): PlanEntryStatus {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'done':
    case 'completed':
      return 'completed';
    default:
      return 'pending';
  }
}

/**
 * If the given {@link ToolInputDisplay} carries a TodoList payload, project it
 * into an ACP `plan` session update. Returns `null` for every other display
 * kind.
 */
export function planFromDisplayBlock(
  sessionId: string,
  turnId: number,
  display: ToolInputDisplay,
): SessionNotification | null {
  if (display.kind !== 'todo_list') return null;
  return todoListToSessionUpdate(sessionId, turnId, display.items);
}

/**
 * Build a one-shot ACP `available_commands_update` session notification.
 */
export function availableCommandsUpdateNotification(
  sessionId: string,
  commands: ReadonlyArray<AvailableCommand> = [],
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: commands.slice(),
    },
  };
}

/**
 * Build a `current_mode_update` session notification, emitted after
 * `session/set_mode` (or the `mode` config-option arm) changes the active
 * mode. Coexists with `config_option_update`: the two serve clients reading
 * the first-class `modes` state and clients reading `configOptions`
 * respectively.
 */
export function currentModeUpdateNotification(
  sessionId: string,
  currentModeId: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'current_mode_update',
      currentModeId,
    },
  };
}

/**
 * Build a `config_option_update` session notification, emitted after the model
 * / mode / thinking pickers change so clients repaint the dropdown's selected
 * indicator.
 */
export function configOptionUpdateNotification(
  sessionId: string,
  configOptions: readonly SessionConfigOption[],
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: [...configOptions],
    },
  };
}

/**
 * Build a one-shot `usage_update` session notification, emitted after a turn
 * settles. `used` is the agent's current context token count, `size` the bound
 * model's max context size; `cost` stays omitted (the engine has no cost
 * data).
 */
export function usageUpdateNotification(
  sessionId: string,
  used: number,
  size: number,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used,
      size,
    },
  };
}

/**
 * Build a `session_info_update` session notification for a title change.
 * `title: null` clears the title client-side.
 */
export function sessionInfoUpdateNotification(
  sessionId: string,
  title: string | null,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      title,
    },
  };
}
