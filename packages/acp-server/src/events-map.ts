import type {
  AvailableCommand,
  PlanEntry,
  PlanEntryStatus,
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
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
 */
export function toolResultToSessionUpdate(
  sessionId: string,
  event: ToolResultEvent,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: acpToolCallId(event.turnId, event.toolCallId),
      status: event.isError ? 'failed' : 'completed',
      content: toolResultToAcpContent(event),
      rawOutput: event.output,
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
