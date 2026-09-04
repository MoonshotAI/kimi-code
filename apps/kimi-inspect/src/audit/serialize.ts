/**
 * Serialize a `ChatState` into a plain, JSON-shaped object for the audit
 * panel's state tree and structural diff. Maps become key-sorted plain
 * objects (stable display order); everything else is passed through by
 * reference (state is immutable, so sharing is safe and keeps the
 * reference-equality fast path in `diffValue` useful).
 */

import type {
  InteractionMessage,
  SessionStateMessage,
  TaskMessage,
  TodoMessage,
} from '@moonshot-ai/kap-server/protocol';

import type { ChatState, TimelineMessage } from '../transcript/store';

/** Plain-object view of a `ChatState` (Maps unwrapped). */
export interface SerializedChatState {
  readonly timeline: readonly TimelineMessage[];
  readonly interactions: Record<string, InteractionMessage>;
  readonly tasks: Record<string, TaskMessage>;
  readonly todos: Record<string, TodoMessage>;
  readonly sessionState: SessionStateMessage | undefined;
  readonly hasMoreOlder: boolean;
}

function mapToSortedObject<V>(map: ReadonlyMap<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of [...map.keys()].toSorted()) out[key] = map.get(key) as V;
  return out;
}

export function serializeState(state: ChatState): SerializedChatState {
  return {
    timeline: state.entries.map((entry) => entry.message),
    interactions: mapToSortedObject(state.interactions),
    tasks: mapToSortedObject(state.tasks),
    todos: mapToSortedObject(state.todos),
    sessionState: state.sessionState,
    hasMoreOlder: state.hasMoreOlder,
  };
}
