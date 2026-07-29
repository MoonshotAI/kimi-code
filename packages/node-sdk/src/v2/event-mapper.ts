/**
 * v2 → v1 event translation for the SDK event channel (pure mapping layer).
 *
 * The v2 engine's per-agent `IEventBus` publishes `DomainEvent`s whose
 * payloads are already v1-protocol-shaped — the same shapes the v1 core emits
 * through `Agent.emitEvent` (the run-v2-print runner renders them untranslated
 * for the same reason). What the bus does not carry is the
 * `sessionId` / `agentId` stamping: the bus is per-agent, so the engine-side
 * consumer knows both (kap-server's broadcaster stamps them the same way).
 * This module restores the stamping and reconciles the two streams' type
 * sets: v2-only types are dropped (the v1 `Event` union is closed), the task
 * lifecycle pair is renamed back to the legacy spelling, and the one
 * v1-visible fact the v2 engine publishes on the process-global
 * `IEventService` (`session.meta.updated`) is unwrapped from its
 * `{type, payload}` envelope.
 */
import type { Event } from '@moonshot-ai/agent-core';
import type { DomainEvent } from '@moonshot-ai/agent-core-v2';

/**
 * DomainEvent types the v1 SDK event stream never carries:
 * - v2-internal facts with no v1 protocol counterpart: `agent.activity.updated`
 *   (kap-server folds it into the `agent.status.updated` phase slice at the WS
 *   edge), `context.spliced`, `task.notified`, `plan.revision`, and the
 *   `permission.approval.*` pair (v1 surfaces approvals through the
 *   `requestApproval` callback, never as events).
 * - `prompt.*`: the v2 prompt service publishes them on the agent bus, but in
 *   v1 they are synthesized by the daemon services layer onto the global
 *   `IEventService` — the in-process SDK client never sees them.
 */
const DROPPED_DOMAIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.activity.updated',
  'context.spliced',
  'task.notified',
  'plan.revision',
  'permission.approval.requested',
  'permission.approval.resolved',
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
]);

/**
 * Type renames needed to reproduce the v1 stream: the v1 core emits task
 * lifecycle facts under the legacy `background.task.*` spelling where v2 uses
 * `task.*`. The payloads are field-identical ports (kap-server fans out both
 * spellings; the v1 SDK client only ever saw the legacy one).
 */
const RENAMED_DOMAIN_EVENT_TYPES: Readonly<Record<string, string>> = {
  'task.started': 'background.task.started',
  'task.terminated': 'background.task.terminated',
};

/**
 * Translate one agent-bus event into the v1 `Event` shape (payload plus the
 * `sessionId` / `agentId` stamping), or `undefined` when the type has no
 * place in the v1 stream (see {@link DROPPED_DOMAIN_EVENT_TYPES}). The cast
 * only bridges the two packages' type declarations — every type not dropped
 * or renamed carries a payload that is field-identical with its v1 protocol
 * counterpart.
 */
export function translateDomainEvent(
  event: DomainEvent,
  sessionId: string,
  agentId: string,
): Event | undefined {
  if (DROPPED_DOMAIN_EVENT_TYPES.has(event.type)) return undefined;
  const type = RENAMED_DOMAIN_EVENT_TYPES[event.type] ?? event.type;
  return { ...event, type, sessionId, agentId } as unknown as Event;
}

/**
 * Translate one process-global `IEventService` fact (`{type, payload}`
 * envelope) into the v1 `Event` shape. Only `session.meta.updated` crosses:
 * it is the one fact v1 publishes through the session RPC (the prompt
 * metadata path, with the same payload fields nested under `payload`); every
 * other global-bus type is a daemon/WS-edge event the in-process v1 client
 * never saw.
 */
export function translateGlobalEvent(event: {
  readonly type: string;
  readonly payload: unknown;
}): Event | undefined {
  if (event.type !== 'session.meta.updated' || typeof event.payload !== 'object') {
    return undefined;
  }
  return { type: event.type, ...event.payload } as unknown as Event;
}
