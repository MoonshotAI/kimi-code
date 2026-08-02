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
  EngineToolSettledEvent,
  EngineToolStartedEvent,
  ToolInputDisplay,
} from '@moonshot-ai/kimi-code-sdk';

import { toolResultToAcpContent } from './convert';
import type { AcpStopReason } from './types';

/**
 * Build an ACP `session/update` notification with an
 * `agent_message_chunk` payload from a text delta part of the engine's
 * `llm.delta` event.
 *
 * Verified against `node_modules/.../sdk/dist/schema/types.gen.d.ts`:
 *  - `SessionNotification` has `{ sessionId, update }` (camelCase),
 *  - `SessionUpdate` is a discriminated union by the `sessionUpdate`
 *    field; the agent-text variant uses the literal `'agent_message_chunk'`,
 *  - inside the chunk the content is a `ContentBlock` with `type: 'text'`.
 */
export function assistantDeltaToSessionUpdate(
  sessionId: string,
  text: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  };
}

/**
 * Map an engine `session.turn.ended.stop_reason` string to an ACP
 * `stopReason`.
 *
 * The engine's stop-reason vocabulary (`EndTurn` / `MaxTokens` /
 * `Filtered` / `Paused` / `Aborted`) is a plain string — the adapter is
 * the translation boundary to ACP's `StopReason`:
 *  - `EndTurn`    → `end_turn`: the model finished a clean turn.
 *  - `Aborted`    → `cancelled`: the client/agent cancelled mid-turn.
 *  - `Filtered`   → `refusal`: the provider's safety policy blocked the
 *    response. ACP's `refusal` stop reason is the native signal for a
 *    model/provider decline, so the client can render the block instead
 *    of mistaking it for a clean `end_turn`.
 *  - anything else (`MaxTokens` / `Paused` / future reasons) → `end_turn`:
 *    ACP has no dedicated variant for them, and resolving keeps the
 *    client unblocked.
 */
export function turnStopReasonToAcpStopReason(stopReason: string): AcpStopReason {
  switch (stopReason) {
    case 'EndTurn':
      return 'end_turn';
    case 'Aborted':
      return 'cancelled';
    case 'Filtered':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * Heuristic map from a Kimi tool's `name` to ACP {@link ToolKind}.
 *
 * Pure, never throws — defaults to `'other'` whenever the name is
 * unrecognized so we never block streaming on an unknown tool. The
 * mapping favours common builtin tool names (Read/Write/Edit/Bash/etc.);
 * MCP / user-defined tools fall through to `'other'` and the client UI
 * picks a generic icon.
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
 * Best-effort JSON stringification for tool args.
 *
 * Tool args are typed as `unknown` on the SDK side; in practice they're
 * JSON-encodable, but a `BigInt` / circular structure would throw. We
 * never want a streaming push to crash the prompt loop, so we fall back
 * to `String(args)` — the client UI shows a degraded preview, the
 * turn keeps running.
 */
export function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/**
 * Build the ACP `session/update` for the `tool_call` create notification
 * from the engine's `session.tool.started` event.
 *
 * The wire shape is verified at `types.gen.d.ts:5396-5443`: `ToolCall`
 * has a required `title` plus optional `kind`/`status`/`content`/
 * `rawInput`. `sessionUpdate: 'tool_call'` is the discriminator (snake
 * literal, camel field — `types.gen.d.ts:4845`).
 *
 * The engine event carries no `turn_id`, so the ACP wire `toolCallId` is
 * the raw engine `tool_call_id` verbatim (no `${turnId}:` prefix — the
 * engine guarantees id uniqueness on its own stream). `title` is the
 * tool name, `kind` is heuristic-mapped, and `rawInput`/`content` mirror
 * the engine's `arguments` payload (omitted when absent).
 */
export function toolCallStartToSessionUpdate(
  sessionId: string,
  event: EngineToolStartedEvent,
): SessionNotification {
  const args = event.arguments;
  const content: ToolCallContent[] =
    args === undefined
      ? []
      : [{ type: 'content', content: { type: 'text', text: stringifyArgs(args) } }];
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: event.tool_call_id,
      title: event.tool_name,
      kind: inferToolKind(event.tool_name),
      status: 'in_progress',
      rawInput: args,
      content,
    },
  };
}

/**
 * Map a `thinking.delta` part of the engine's `llm.delta` event to an
 * `agent_thought_chunk` notification.
 *
 * Mirrors `assistantDeltaToSessionUpdate` shape but uses the
 * `'agent_thought_chunk'` variant (`types.gen.d.ts:4845`).
 */
export function thinkingDeltaToSessionUpdate(
  sessionId: string,
  text: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    },
  };
}

/**
 * Map a `session.tool.settled` event to the **terminal**
 * `tool_call_update` notification for that call.
 *
 * Wire shape (`types.gen.d.ts:5505-5547`): ToolCallUpdate is REPLACE
 * semantics for `content` — the result's content array overwrites the
 * streaming args preview with the final tool output. `status` flips to
 * `completed` (success) or `failed` (`event.is_error === true`).
 * `rawOutput` preserves the engine's content string for clients that
 * want it.
 */
export function toolResultToSessionUpdate(
  sessionId: string,
  event: EngineToolSettledEvent,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: event.tool_call_id,
      status: event.is_error ? 'failed' : 'completed',
      content: toolResultToAcpContent(event.content),
      rawOutput: event.content,
    },
  };
}

/**
 * Translate the kimi-code TodoList display block into an ACP `plan`
 * session update.
 *
 * Mapping rules (anchored at types.gen.d.ts:3530-3569 / :4849):
 *   - The `todo_list` input-display block carries
 *     `items: { title, status }[]` (schemas.ts:60). The status is the
 *     three-state TodoStatus union (todo-list.ts:26):
 *     `pending` | `in_progress` | `done`.
 *   - ACP {@link PlanEntryStatus} is `pending` | `in_progress` | `completed`,
 *     so `done` rewrites to `completed`. Anything outside the known
 *     enum lands on `pending` as a safe default — we never want a
 *     plan emission to crash the prompt loop.
 *   - We default `priority` to `'medium'` because the kimi-code
 *     TodoList does not carry a priority axis today.
 *   - `title` → `content` (ACP names it `content` per :3548).
 *
 * Returns `null` if the items array is empty — there is no useful
 * client-side state in "I emit the plan now, but it's empty" beyond
 * the eventual `plan_removed` story (deferred until kimi-code grows
 * a clear-plan signal).
 */
export function todoListToSessionUpdate(
  sessionId: string,
  turnId: number,
  items: ReadonlyArray<{ title: string; status: string }>,
): SessionNotification | null {
  // turnId is accepted for symmetry with other events-map helpers and
  // for future debug-log enrichment; the ACP `plan` wire shape is
  // session-scoped (types.gen.d.ts:3499 — "The client replaces the
  // entire plan with each update") so we do not embed it in the payload.
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
 * If the given {@link ToolInputDisplay} carries a TodoList payload,
 * project it into an ACP `plan` session update. Returns `null` for
 * every other display kind (the caller drops them).
 *
 * The kimi-code TodoList tool publishes both a structured display
 * (`kind: 'todo_list'`) and a textual `tool.result` output. The
 * display is the canonical structured signal — we wire it to ACP
 * here instead of trying to parse the textual output.
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
 * Build a one-shot ACP `available_commands_update` session
 * notification. The Kimi adapter sits at the SDK layer, beneath the
 * TUI slash-command registry (`apps/kimi-code/src/tui/commands/`),
 * so today we have no in-process source of structured slash commands
 * to enumerate. We still emit the wire-shape once per session so
 * clients that subscribe to the channel see a deterministic empty
 * update rather than waiting forever; an upper layer can fill it in
 * later (Phase 11 / ext_method handoff in PLAN D9).
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
 * Build a `config_option_update` session notification.
 *
 * Emitted from {@link AcpSession.emitConfigOptionUpdate} after either the
 * model or the mode picker changes — through any of the three input
 * paths (`unstable_setSessionModel`, `setSessionMode`, or the unified
 * `setSessionConfigOption`). Consumed by ACP clients (Zed) to repaint
 * the dropdown's selected indicator so the visible config mirrors the
 * adapter's authoritative state.
 *
 * The discriminator literal `'config_option_update'` matches the SDK's
 * `ConfigOptionUpdate & { sessionUpdate: 'config_option_update' }` arm of
 * the `SessionUpdate` union (`types.gen.d.ts:788-803`, `:4858-4859`).
 *
 * Phase 14.3 (PLAN D11) introduces this in lieu of Phase 12's
 * `current_mode_update`; the legacy helper was deleted in the same
 * commit because it has no remaining callers.
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
