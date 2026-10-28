/**
 * Serialize a `ChatState` into a plain, JSON-shaped object for the audit
 * panel's state tree and structural diff. Maps become key-sorted plain
 * objects (stable display order), Sets become sorted arrays; everything
 * else is passed through by reference (state is immutable, so sharing is
 * safe and keeps the reference-equality fast path in `diffValue` useful).
 */

import type {
  TranscriptAttachment,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptMeta,
  TranscriptTodo,
} from '@moonshot-ai/transcript';

import type { ChatState } from '../transcript/store';
import type { TaskFrame } from '../transcript/ws';

/** Plain-object view of a `ChatState` (Maps/Sets unwrapped). */
export interface SerializedAgentState {
  readonly items: readonly TranscriptItem[];
  readonly tasks: Record<string, TaskFrame>;
  readonly interactions: Record<string, TranscriptInteraction>;
  readonly attachments: Record<string, TranscriptAttachment>;
  readonly todos: Record<string, TranscriptTodo>;
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: readonly string[];
  readonly hasMoreOlder: boolean;
}

function mapToSortedObject<V>(map: ReadonlyMap<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of [...map.keys()].toSorted()) out[key] = map.get(key) as V;
  return out;
}

export function serializeState(state: ChatState): SerializedAgentState {
  return {
    items: state.items,
    tasks: mapToSortedObject(state.tasks),
    interactions: mapToSortedObject(state.interactions),
    attachments: mapToSortedObject(state.attachments),
    todos: mapToSortedObject(state.todos),
    meta: state.meta,
    pendingInteractions: [...state.pendingInteractions].toSorted(),
    hasMoreOlder: state.hasMoreOlder,
  };
}
