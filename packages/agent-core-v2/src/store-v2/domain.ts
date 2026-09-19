import { produce } from 'immer';

import {
  ContextAppendMessage,
  ContextClear,
} from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import {
  UsageRecord,
  usageKey,
} from '#/agent/usage/usageOps';
import {
  event2FromRecord,
  type Event2Class,
} from '#/app/event/event2';
import {
  readTodoItems,
  type TodoItem,
} from '#/features/todo/todoItem';
import { ToolsUpdateStore } from '#/features/todo/todoOps';
import {
  inputSubmitted,
  inputCancelled,
  queueDrained,
  messageAppended,
  turnStarted as humanTurnStarted,
  turnEnded as humanTurnEnded,
  stateUpdated,
} from '#human/agent/events';
import {
  historySlice,
  queueSlice,
} from '#human/agent/slices';
import type { UserEntry } from '#human/agent/turn';
import type { TokenUsage } from '#human/llm/usage';
import type {
  FoldContext as HumanFoldContext,
  Slice,
} from '#human/store/log';
import { todoSlice } from '#human/todo/slice';
import type { FoldContext } from '#/state/state';

import type { Projection } from './store';

export interface DomainRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

const v2Classes = [
  ContextAppendMessage,
  ContextClear,
  TurnStarted,
  TurnEnded,
  ToolsUpdateStore,
  UsageRecord,
] as const;

const humanFactories = [
  inputSubmitted,
  inputCancelled,
  queueDrained,
  messageAppended,
  humanTurnStarted,
  humanTurnEnded,
  stateUpdated,
] as const;

export type V2Event = InstanceType<(typeof v2Classes)[number]>;
export type HumanEvent = ReturnType<(typeof humanFactories)[number]>;
export type ConversationState = readonly ContextMessage[];
export type TodoState = readonly TodoItem[];
export type UsageState = ReturnType<typeof usageKey.initial>;

export interface TurnPosition<C> {
  readonly turnId: number;
  readonly start: C;
  readonly end?: C;
}

export interface TurnIndex<C> {
  readonly turns: readonly TurnPosition<C>[];
  readonly nextTurnId: number;
}

export interface HumanState<C> {
  readonly history: ReturnType<typeof historySlice.initialState>;
  readonly queue: ReturnType<typeof queueSlice.initialState>;
  readonly todo: ReturnType<typeof todoSlice.initialState>;
  readonly turnIndex: TurnIndex<C>;
}

export const fixtureAgentId = 'agent-1';
export const fixtureModel = 'example-model';
export const fixtureTime = Date.UTC(2026, 8, 16);

function checkedTime(record: DomainRecord): number {
  if (record.time !== undefined && !Number.isFinite(record.time)) {
    throw new TypeError(`Invalid event time for '${record.type}'`);
  }
  return record.time ?? 0;
}

export function decodeV2(record: DomainRecord): V2Event | undefined {
  const cls: Event2Class | undefined = v2Classes.find((candidate) =>
    candidate.type === record.type || candidate.aliases.includes(record.type));
  if (cls === undefined) return undefined;
  const event = event2FromRecord(cls, { ...record, time: checkedTime(record) });
  if (event === undefined) throw new TypeError(`Invalid v2 event '${record.type}'`);
  return event as V2Event;
}

export function decodeHuman(record: DomainRecord): HumanEvent | undefined {
  const factory = humanFactories.find((candidate) => candidate.type === record.type);
  if (factory === undefined) return undefined;
  if ('agentId' in record) throw new TypeError(`Not a human plain event: '${record.type}'`);
  const { type: _type, time: _time, ...payload } = record;
  const parsed = factory.schema.safeParse(payload);
  if (!parsed.success) throw new TypeError(`Invalid human event '${record.type}'`);
  return {
    ...parsed.data as Record<string, unknown>,
    type: factory.type,
    time: checkedTime(record),
  } as HumanEvent;
}

export function conversation<C>(): Projection<ConversationState, DomainRecord, C> {
  return {
    initial: () => [],
    reduce: (state, record) => {
      const event = decodeV2(record);
      if (event instanceof ContextAppendMessage) return [...state, event.message];
      if (event instanceof ContextClear) return [];
      return state;
    },
  };
}

export function todos<C>(): Projection<TodoState, DomainRecord, C> {
  return {
    initial: () => [],
    reduce: (state, record) => {
      const event = decodeV2(record);
      return event instanceof ToolsUpdateStore && event.key === 'todo'
        ? readTodoItems(event.value)
        : state;
    },
  };
}

function unsupportedFoldEffect(): never {
  throw new Error('This projection does not support reducer effects or checkpoints');
}

const usageContext: FoldContext = {
  silent: true,
  checkpoint: unsupportedFoldEffect,
  clearCheckpoints: unsupportedFoldEffect,
  undoToCheckpoint: unsupportedFoldEffect,
  emit: unsupportedFoldEffect,
};

export function usage<C>(): Projection<UsageState, DomainRecord, C> {
  const fold = usageKey.replayable.folds.get(UsageRecord);
  if (fold === undefined) throw new Error('UsageRecord fold is missing');
  return {
    initial: usageKey.initial,
    reduce: (state, record) => {
      const event = decodeV2(record);
      return event instanceof UsageRecord
        ? produce(state, (draft) => fold(draft, event, usageContext))
        : state;
    },
  };
}

export function turns<C>(): Projection<TurnIndex<C>, DomainRecord, C> {
  return {
    initial: () => ({ turns: [], nextTurnId: 0 }),
    reduce: (state, record, cursor) => {
      const event = decodeV2(record);
      if (event instanceof TurnStarted) {
        const turnId = event.turnId ?? state.nextTurnId;
        return {
          turns: [...state.turns, { turnId, start: cursor }],
          nextTurnId: turnId + 1,
        };
      }
      if (event instanceof TurnEnded) {
        const index = state.turns.findLastIndex((turn) => turn.turnId === event.turnId);
        if (index < 0) return state;
        return {
          ...state,
          turns: state.turns.map((turn, i) => i === index ? { ...turn, end: cursor } : turn),
        };
      }
      return state;
    },
  };
}

function foldHumanSlice<S>(slice: Slice<string, S>, state: S, event: HumanEvent): S {
  const reducer = slice.reducers[event.type];
  if (reducer === undefined) return state;
  const context: HumanFoldContext = {
    get ref(): never {
      throw new Error('Position-aware human reducers require a generic cursor adapter');
    },
    ts: event.time,
    replaying: true,
    enqueue: { raise: unsupportedFoldEffect, effect: unsupportedFoldEffect },
  };
  return produce<S, S>(state, (draft) => reducer(draft, event, context));
}

export function human<C>(): Projection<HumanState<C>, DomainRecord, C> {
  return {
    initial: () => ({
      history: historySlice.initialState(),
      queue: queueSlice.initialState(),
      todo: todoSlice.initialState(),
      turnIndex: { turns: [], nextTurnId: 0 },
    }),
    reduce: (state, record, cursor) => {
      const event = decodeHuman(record);
      if (event === undefined) return state;
      let turnIndex = state.turnIndex;
      if (event.type === humanTurnStarted.type) {
        const { turnId } = event as ReturnType<typeof humanTurnStarted>;
        turnIndex = {
          ...turnIndex,
          turns: [...turnIndex.turns, { turnId, start: cursor }],
        };
      } else if (event.type === humanTurnEnded.type) {
        const { turnId } = event as ReturnType<typeof humanTurnEnded>;
        const index = turnIndex.turns.findLastIndex((turn) => turn.turnId === turnId);
        turnIndex = {
          nextTurnId: turnId + 1,
          turns: turnIndex.turns.map((turn, i) => i === index ? { ...turn, end: cursor } : turn),
        };
      }
      const history = foldHumanSlice(historySlice, state.history, event);
      const queue = foldHumanSlice(queueSlice, state.queue, event);
      const todo = foldHumanSlice(todoSlice, state.todo, event);
      return history === state.history && queue === state.queue && todo === state.todo &&
        turnIndex === state.turnIndex ? state : { history, queue, todo, turnIndex };
    },
  };
}

function fixture(turnId: number) {
  if (turnId !== 1 && turnId !== 2) throw new RangeError('Fixture turnId must be 1 or 2');
  const tokenUsage: TokenUsage = {
    inputOther: 10 * turnId,
    output: 3 * turnId,
    inputCacheRead: 2 * turnId,
    inputCacheCreation: 0,
  };
  const todo: TodoItem = {
    title: 'Implement the store experiment',
    status: turnId === 1 ? 'pending' : 'done',
  };
  return {
    promptId: `p${turnId}`,
    prompt: turnId === 1 ? 'Plan the store experiment.' : 'Complete the store experiment.',
    reply: turnId === 1 ? 'The implementation is planned.' : 'The implementation is complete.',
    time: fixtureTime + (turnId - 1) * 1_000,
    tokenUsage,
    todo,
  };
}

export function turnEvents(turnId: number): readonly DomainRecord[] {
  const { promptId, prompt, reply, time, tokenUsage, todo } = fixture(turnId);
  const message: ContextMessage = {
    id: promptId,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
  const events: V2Event[] = [
    new ContextAppendMessage({ agentId: fixtureAgentId, message }, time),
    new TurnStarted({
      agentId: fixtureAgentId,
      turnId,
      promptId,
      origin: { kind: 'user' },
      input: message.content,
    }, time + 1),
    new ToolsUpdateStore({ agentId: fixtureAgentId, key: 'todo', value: [todo] }, time + 2),
    new UsageRecord({
      agentId: fixtureAgentId,
      model: fixtureModel,
      usage: tokenUsage,
      usageScope: 'turn',
    }, time + 3),
    new ContextAppendMessage({
      agentId: fixtureAgentId,
      message: {
        id: `a${turnId}`,
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        toolCalls: [],
      },
    }, time + 4),
    new TurnEnded({
      agentId: fixtureAgentId,
      turnId,
      reason: 'completed',
      durationMs: 4,
    }, time + 5),
  ];
  return events.map((event) => {
    const decoded = decodeV2(event.serialize());
    if (decoded === undefined) throw new Error(`Unsupported v2 fixture '${event.type}'`);
    return decoded.serialize();
  });
}

export function humanTurnEvents(turnId: number): readonly DomainRecord[] {
  const { promptId, prompt, reply, time, tokenUsage, todo } = fixture(turnId);
  const entry: UserEntry = {
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    meta: { source: 'input', promptId, origin: { kind: 'user' } },
  };
  const cancelledId = `cancelled-${turnId}`;
  const events: HumanEvent[] = [
    inputSubmitted({ entry }),
    inputSubmitted({
      id: cancelledId,
      message: { role: 'user', content: [{ type: 'text', text: 'Withdraw this queued input.' }] },
    }),
    inputCancelled({ id: cancelledId }),
    queueDrained({ id: promptId }),
    messageAppended({ message: entry }),
    humanTurnStarted({ turnId, queueItemId: promptId }),
    stateUpdated({ name: 'todo', value: { todos: [todo], lastWriteTurn: turnId } }),
    messageAppended({
      message: {
        message: { role: 'assistant', content: [{ type: 'text', text: reply }], toolCalls: [] },
        meta: { usage: tokenUsage, model: { provider: 'example', model: fixtureModel } },
      },
    }),
    humanTurnEnded({ turnId, outcome: 'done' }),
  ];
  return events.map((event, index) => {
    const decoded = decodeHuman({ ...event, time: time + index });
    if (decoded === undefined) throw new Error(`Unsupported human fixture '${event.type}'`);
    return { ...decoded };
  });
}
