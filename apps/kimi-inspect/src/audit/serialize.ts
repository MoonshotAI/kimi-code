/**
 * Serialize an `AgentState` into a plain, JSON-shaped object for the audit
 * panel's state tree and structural diff. Maps become key-sorted plain
 * objects (stable display order), Sets become sorted arrays; everything
 * else is passed through by reference (state is immutable, so sharing is
 * safe and keeps the reference-equality fast path in `diffValue` useful).
 */

import type {
  AgentState,
  TranscriptAttachment,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptMeta,
  TranscriptTask,
  TranscriptTodo,
} from '@moonshot-ai/transcript';

/** Plain-object view of an `AgentState` (Maps/Sets unwrapped). */
export interface SerializedAgentState {
  readonly items: readonly TranscriptItem[];
  readonly tasks: Record<string, TranscriptTask>;
  readonly interactions: Record<string, TranscriptInteraction>;
  readonly attachments: Record<string, TranscriptAttachment>;
  readonly todos: Record<string, TranscriptTodo>;
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: readonly string[];
  readonly hasMoreOlder: boolean;
}

function mapToSortedObject<V>(map: ReadonlyMap<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key) as V;
  return out;
}

export function serializeState(state: AgentState): SerializedAgentState {
  return {
    items: state.items,
    tasks: mapToSortedObject(state.tasks),
    interactions: mapToSortedObject(state.interactions),
    attachments: mapToSortedObject(state.attachments),
    todos: mapToSortedObject(state.todos),
    meta: state.meta,
    pendingInteractions: [...state.pendingInteractions].sort(),
    hasMoreOlder: state.hasMoreOlder,
  };
}
