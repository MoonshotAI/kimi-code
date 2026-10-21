import type {
  AgentState,
  TranscriptAttachment,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptMeta,
  TranscriptTask,
  TranscriptTodo,
} from '@moonshot-ai/transcript';

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
