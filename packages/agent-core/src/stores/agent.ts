import { createUserEntry, type HistoryMessage, type UserEntry } from '#/llm/message';
import { decodeRecord, type RecordEvent } from '#/store/journal';
import { openStore, type Journal, type Projection, type Store } from '#/store/store';
import type { BranchRef } from '#/store/tree';

export type MessageAppended = {
  readonly type: 'message.appended';
  readonly time?: number;
  readonly message: HistoryMessage;
};

export type TurnStarted = {
  readonly type: 'turn.started';
  readonly time?: number;
  readonly turnId: number;
  readonly queueItemId?: string;
};

export type TurnEnded = {
  readonly type: 'turn.ended';
  readonly time?: number;
  readonly turnId: number;
  readonly outcome: 'done' | 'failed' | 'aborted';
  readonly errorMessage?: string;
};

export type InputSubmitted = {
  readonly type: 'input.submitted';
  readonly time?: number;
  readonly entry: UserEntry;
};

export type AgentLogEvent = MessageAppended | TurnStarted | TurnEnded | InputSubmitted;

const agentLogTypes = new Set<AgentLogEvent['type']>([
  'input.submitted',
  'message.appended',
  'turn.started',
  'turn.ended',
]);

export interface TurnPosition<C> {
  readonly turnId: number;
  readonly start: C;
  readonly end?: C;
}

export interface TurnIndex<C> {
  readonly turns: readonly TurnPosition<C>[];
  readonly nextTurnId: number;
}

export interface AgentLogState<C> {
  readonly history: HistoryMessage[];
  readonly queue: UserEntry[];
  readonly notifications: UserEntry[];
  readonly reminders: HistoryMessage[];
  readonly turnIndex: TurnIndex<C>;
}

export function decodeAgent(record: RecordEvent): AgentLogEvent | undefined {
  if ('agentId' in record) throw new TypeError(`Not an agent plain event: '${record.type}'`);
  return decodeRecord<AgentLogEvent>(record, agentLogTypes);
}

function foldTurnIndex<C>(state: TurnIndex<C>, event: AgentLogEvent, cursor: C): TurnIndex<C> {
  if (event.type === 'turn.started') {
    return { ...state, turns: [...state.turns, { turnId: event.turnId, start: cursor }] };
  }
  if (event.type === 'turn.ended') {
    const { turnId } = event;
    const index = state.turns.findLastIndex((turn) => turn.turnId === turnId);
    return {
      nextTurnId: turnId + 1,
      turns: state.turns.map((turn, i) => i === index ? { ...turn, end: cursor } : turn),
    };
  }
  return state;
}

export function agent<C>(): Projection<AgentLogState<C>, RecordEvent, C> {
  return {
    initial: () => ({
      history: [],
      queue: [],
      notifications: [],
      reminders: [],
      turnIndex: { turns: [], nextTurnId: 0 },
    }),
    reduce: (state, record, cursor) => {
      const event = decodeAgent(record);
      if (event === undefined) return state;
      if (event.type === 'message.appended') {
        return { ...state, history: [...state.history, event.message] };
      }
      if (event.type === 'input.submitted') {
        return {
          ...state,
          queue: [...state.queue, createUserEntry(event.entry.message, { source: 'input', ...event.entry.meta })],
        };
      }
      const turnIndex = foldTurnIndex(state.turnIndex, event, cursor);
      return turnIndex === state.turnIndex ? state : { ...state, turnIndex };
    },
  };
}

export type AgentStore<C = BranchRef> = Store<AgentLogState<C>, RecordEvent, C>;

export type AgentStoreState<C = BranchRef> = AgentLogState<C>;

export function openAgentStore<C>(journal: Journal<RecordEvent, C>): Promise<AgentStore<C>> {
  return openStore({ journal, projection: agent<C>() });
}
