/**
 * v2 → v1 event translation for the SDK event channel (pure mapping layer).
 *
 * The v2 engine's per-agent `IEventBus` publishes `DomainEvent`s. This module
 * projects their payloads into the v1 protocol shape and restores the
 * `sessionId` / `agentId` stamping: the bus is per-agent, so the engine-side
 * consumer knows both (kap-server's broadcaster stamps them the same way).
 * It also reconciles the two streams' type
 * sets: v2-only types are dropped (the v1 `Event` union is closed), the task
 * lifecycle pair is renamed back to the legacy spelling, and the one
 * v1-visible fact the v2 engine publishes on the process-global
 * `IEventService` (`session.meta.updated`) is unwrapped from its
 * `{type, payload}` envelope.
 */
import type { Event } from '@moonshot-ai/agent-core-v2/events';
import type { Event2 } from '@moonshot-ai/agent-core-v2';
import { fromCorePart } from '@moonshot-ai/agent-core-v2/human/message';

function isCoreMediaPart(part: unknown): part is Parameters<typeof fromCorePart>[0] {
  if (typeof part !== 'object' || part === null || !('type' in part) || !('source' in part)) {
    return false;
  }
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') {
    return false;
  }
  const source = part.source;
  if (typeof source !== 'object' || source === null || !('kind' in source)) return false;
  return (
    source.kind === 'url' ||
    source.kind === 'inline' ||
    source.kind === 'file' ||
    source.kind === 'store'
  );
}

function projectToolResultOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  return output.map((part) => (isCoreMediaPart(part) ? fromCorePart(part) : part));
}

/**
 * DomainEvent types the v1 SDK event stream never carries:
 * - v2-internal facts with no v1 protocol counterpart: `context.spliced`,
 *   `task.notified`, `plan.revision`, and the `permission.approval.*` pair
 *   (v1 surfaces approvals through the `requestApproval` callback, never as
 *   events).
 * - `prompt.*` other than `prompt.completed`: the v2 prompt service publishes
 *   them on the agent bus, but in v1 they are synthesized by the daemon
 *   services layer onto the global `IEventService` — the in-process SDK client
 *   never sees them. Only `prompt.completed(blocked)` remains visible because
 *   a pre-turn hook rejection has no `turn.ended` counterpart that could
 *   settle the UI.
 */
const DROPPED_DOMAIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.spliced',
  'task.notified',
  'plan.revision',
  'permission.approval.requested',
  'permission.approval.resolved',
  'prompt.submitted',
  'prompt.aborted',
  'prompt.started',
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
 * only bridges the two packages' type declarations after media payloads have
 * been projected back to their public legacy shape.
 */
export function translateDomainEvent(
  event: Event2<any>,
  sessionId: string,
  agentId: string,
): Event | undefined {
  if (
    event.type === 'prompt.completed' &&
    (event as { readonly reason?: string }).reason !== 'blocked'
  ) {
    return undefined;
  }
  if (DROPPED_DOMAIN_EVENT_TYPES.has(event.type)) return undefined;
  const type = RENAMED_DOMAIN_EVENT_TYPES[event.type] ?? event.type;
  if (event.type === 'turn.started') {
    const { promptAttachments: _internal, ...publicFields } = event as Event2<any> & {
      promptAttachments?: unknown;
    };
    return Object.assign({}, publicFields, { type, sessionId, agentId }) as unknown as Event;
  }
  if (event.type === 'tool.result') {
    const output = (event as { readonly output?: unknown }).output;
    return Object.assign({}, event, {
      output: projectToolResultOutput(output),
      type,
      sessionId,
      agentId,
    }) as unknown as Event;
  }
  return Object.assign({}, event, { type, sessionId, agentId }) as unknown as Event;
}

/**
 * Translate one process-global `IEventService` fact (`{type, payload}`
 * envelope) into the v1 `Event` shape. Only `session.meta.updated` crosses:
 * it is the one fact v1 publishes through the session RPC (the prompt
 * metadata path, with the same payload fields nested under `payload`); every
 * other global-bus type is a daemon/WS-edge event the in-process v1 client
 * never saw.
 */
export function translateGlobalEvent(event: Event2<any>): Event | undefined {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (event.type !== 'session.meta.updated' || typeof payload !== 'object') {
    return undefined;
  }
  return { type: event.type, ...payload } as unknown as Event;
}
