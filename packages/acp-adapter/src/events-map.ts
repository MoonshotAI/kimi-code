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
} from '@moonshot-ai/kimi-code-sdk';

import { displayBlockToAcpContent, toolResultToAcpContent } from './convert';
import type { AcpStopReason } from './types';

/**
 * Build an ACP `session/update` notification with an
 * `agent_message_chunk` payload from an SDK `assistant.delta` event.
 *
 * Verified against `node_modules/.../sdk/dist/schema/types.gen.d.ts`:
 *  - `SessionNotification` has `{ sessionId, update }` (camelCase),
 *  - `SessionUpdate` is a discriminated union by the `sessionUpdate`
 *    field; the agent-text variant uses the literal `'agent_message_chunk'`,
 *  - inside the chunk the content is a `ContentBlock` with `type: 'text'`.
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
 * Map an SDK {@link TurnEndReason} to an ACP `stopReason`.
 *
 * `completed` → `end_turn`: the model finished a clean turn.
 * `cancelled` → `cancelled`: the client/agent cancelled mid-turn.
 * `failed`    → `end_turn` *with* an out-of-band log: the SDK reports a
 *   step-level error via `TurnEndedEvent.error`. ACP's `StopReason` does
 *   not have a dedicated `failed` variant in this protocol version, and
 *   the spec discourages signaling errors through `stopReason` (errors
 *   belong on the JSON-RPC error channel). Returning `end_turn` keeps the
 *   client unblocked; the caller is expected to log the `error` payload
 *   separately so the failure is observable in the agent logs.
 * `filtered`  → `refusal`: the provider's safety policy blocked the
 *   response. ACP's `refusal` stop reason is the native signal for a
 *   model/provider decline, so the client can render the block instead of
 *   mistaking it for a clean `end_turn`. The caller additionally logs the
 *   block so it stays observable in the agent logs.
 */
export function turnEndReasonToStopReason(reason: TurnEndReason): AcpStopReason {
  switch (reason) {
    case 'completed':
      return 'end_turn';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'end_turn';
    case 'filtered':
      return 'refusal';
  }
}

/**
 * Build the ACP `toolCallId` for a wire-level tool call.
 *
 * Composes `${turnId}:${toolCallId}` so multiple turns within a single
 * session (which legitimately reuse the same model-assigned tool call
 * id when the model retries) do not collide on the ACP side. The SDK's
 * raw `toolCallId` remains the in-process accumulator key — only the
 * ACP wire id is prefixed (matches Python reference at `acp/session.py`).
 */
export function acpToolCallId(turnId: number, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
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
 *
 * Exported because `session.ts` seeds the per-tool-call args accumulator
 * with the **initial** args stringification so subsequent
 * `tool.call.delta` fragments append correctly.
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
 * notification from an SDK `tool.call.started` event.
 *
 * The wire shape is verified at `types.gen.d.ts:5396-5443`: `ToolCall`
 * has a required `title` plus optional `kind`/`status`/`content`/
 * `rawInput`. `sessionUpdate: 'tool_call'` is the discriminator (snake
 * literal, camel field — `types.gen.d.ts:4845`).
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
  // If the tool attached a diff-bearing display (kind: 'diff' or
  // 'file_io' with both before/after set), prepend an inline diff
  // entry so the client can render it alongside the textual args
  // preview. Non-diff display kinds are skipped here (their
  // information is already in the args text).
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
 * Build a `tool_call_update` for a streaming arguments delta.
 *
 * Mutates `accumulator.args` with the new fragment, then emits a wire
 * notification whose `content` is the cumulative args text (so each
 * update fully replaces the previous content array — that's the wire
 * semantics; `ToolCallUpdate.content` is REPLACE, not APPEND, see
 * `types.gen.d.ts:5520` "Replace the content collection").
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
 * Build the initial ACP `tool_call` (CREATE) notification from the
 * **first** `tool.call.delta` event for a given `toolCallId`.
 *
 * Background: the agent-core emits `tool.call.delta` events while the
 * provider streams the model's tool-call args, and only later emits
 * `tool.call.started` (after the streaming phase, when the call is
 * dispatched). The naive mapping — start → tool_call, delta → tool_call_update
 * — therefore lands updates on the wire *before* the create, which makes
 * Zed log "Tool call not found" until the start eventually arrives.
 * This helper lets the adapter lazy-create the wire tool_call from the
 * first delta so subsequent deltas have a legitimate parent to update.
 *
 * Trade-offs vs {@link toolCallStartToSessionUpdate}:
 *  - `title`: only `event.name` is available; `description` (from the
 *    started event) isn't known yet and gets filled in by the upgrade.
 *  - `kind`: inferred from `event.name`; falls back to `'other'` when
 *    the first delta omits the name (defensive — providers usually carry
 *    `name` on the first delta only).
 *  - `rawInput`: omitted; we don't have parsed args at this point. The
 *    upgrade sets it from `tool.call.started.event.args`.
 *  - `content`: seeded with the first `argumentsPart` so the rendered
 *    card starts to fill in immediately rather than flashing empty.
 *  - `status`: `'pending'` to convey "the model is still composing the
 *    call". The upgrade flips it to `'in_progress'`.
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
 * Build a `tool_call_update` that finalises a lazy-created tool call
 * once `tool.call.started` arrives.
 *
 * Used only when {@link toolCallLazyCreateToSessionUpdate} has already
 * emitted a `tool_call` for this `toolCallId` from a streaming delta —
 * we cannot send a second `tool_call` CREATE, so the canonical
 * metadata is delivered as an update instead. The fields are kept in
 * sync with {@link toolCallStartToSessionUpdate}: `title` prefers
 * `description`, `kind` is re-inferred from the canonical `name`,
 * `rawInput` carries the parsed args, and `content` mirrors the
 * start path (optional diff prepended + canonical args text).
 *
 * `status` flips to `'in_progress'`: streaming is done and execution is
 * imminent (or already underway by the time the client renders the
 * update).
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
 * Map an SDK `tool.progress` event to an ACP `tool_call_update`.
 *
 * Only `update.kind === 'status'` with non-empty `text` produces a wire
 * notification (used to refresh the tool card title as the tool reports
 * what it's currently doing). stdout/stderr/progress/custom updates
 * return `null` here — they're folded into the final `tool.result`
 * content in Phase 4.2 rather than streaming as title flickers.
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
 *
 * Mirrors `assistantDeltaToSessionUpdate` shape but uses the
 * `'agent_thought_chunk'` variant (`types.gen.d.ts:4845`).
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
 * notification for that call.
 *
 * Wire shape (`types.gen.d.ts:5505-5547`): ToolCallUpdate is REPLACE
 * semantics for `content` — by the time the result arrives, the
 * adapter has been pushing cumulative-args `tool_call_update`s, so
 * the result's content array overwrites the streaming args preview
 * with the final tool output. `status` flips to `completed` (success)
 * or `failed` (`event.isError === true`). `rawOutput` preserves the
 * SDK's raw output for clients that want it.
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
