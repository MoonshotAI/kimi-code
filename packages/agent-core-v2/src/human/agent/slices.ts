import type { CombinedState, EventStore } from '#/eventStore/eventStore';
import { createSlice } from '#/eventStore/slice';
import type { BranchRef } from '#/store/types';
import type { UserMessage } from '#/llm/message';

import {
  inputCancelled,
  inputDrained,
  inputNotified,
  inputReminded,
  inputSteered,
  inputSubmitted,
  messageAppended,
  notificationsDrained,
  queueDrained,
  turnEnded,
  turnStarted,
  type InputCancelled,
  type InputNotified,
  type InputReminded,
  type InputSteered,
  type InputSubmitted,
  type MessageAppended,
  type TurnEnded,
  type TurnStarted,
} from './events';
import { createSystemEntry, createUserEntry, type HistoryMessage, type UserEntry } from './turn';

export interface QueuedPrompt {
  id?: string;
  message: UserMessage;
}

export const historySlice = createSlice({
  name: 'history',
  initialState: () => [] as HistoryMessage[],
  reducers: {
    [messageAppended.type]: (draft, event: MessageAppended) => {
      draft.push(event.message);
    },
  },
});

export const queueSlice = createSlice({
  name: 'queue',
  initialState: () => [] as QueuedPrompt[],
  reducers: {
    [inputSubmitted.type]: (draft, event: InputSubmitted) => {
      draft.push({ id: event.id, message: event.message });
    },
    [inputCancelled.type]: (draft, event: InputCancelled) =>
      draft.filter((entry) => entry.id !== event.id),
    [inputSteered.type]: (draft, event: InputSteered) =>
      draft.filter((entry) => entry.id !== event.id),
    [queueDrained.type]: (draft) => {
      draft.shift();
    },
  },
});

export const notificationsSlice = createSlice({
  name: 'notifications',
  initialState: () => [] as UserEntry[],
  reducers: {
    [inputNotified.type]: (draft, event: InputNotified) => {
      draft.push(createUserEntry(event.message, { source: event.source ?? 'notify' }));
    },
    [inputSteered.type]: (draft, event: InputSteered) => {
      draft.push(createUserEntry(event.message, { source: 'input' }));
    },
    [inputDrained.type]: () => [],
    [notificationsDrained.type]: () => [],
  },
});

export const remindersSlice = createSlice({
  name: 'reminders',
  initialState: () => [] as HistoryMessage[],
  reducers: {
    [inputReminded.type]: (draft, event: InputReminded) => {
      const kept = draft.filter((entry) => entry.meta.key !== event.key);
      kept.push(
        event.message.role === 'system'
          ? createSystemEntry(event.message, { source: 'reminder', key: event.key })
          : createUserEntry(event.message, { source: 'reminder', key: event.key }),
      );
      return kept;
    },
    [inputDrained.type]: () => [],
  },
});

export interface TurnIndexEntry {
  turnId: number;
  start: BranchRef;
  end?: BranchRef;
}

export interface TurnIndexState {
  turns: TurnIndexEntry[];
  nextTurnId: number;
}

export const turnIndexSlice = createSlice({
  name: 'turnIndex',
  initialState: (): TurnIndexState => ({ turns: [], nextTurnId: 0 }),
  reducers: {
    [turnStarted.type]: (draft, event: TurnStarted, ctx) => {
      draft.turns.push({ turnId: event.turnId, start: ctx.ref });
    },
    [turnEnded.type]: (draft, event: TurnEnded, ctx) => {
      const entry = draft.turns.findLast((turn) => turn.turnId === event.turnId);
      if (entry !== undefined) entry.end = ctx.ref;
      draft.nextTurnId = event.turnId + 1;
    },
  },
});

export const agentSlices = {
  history: historySlice,
  queue: queueSlice,
  notifications: notificationsSlice,
  reminders: remindersSlice,
  turnIndex: turnIndexSlice,
};

export type AgentSlices = typeof agentSlices;
export type AgentEventStore = EventStore<AgentSlices>;
export type AgentStoreState = CombinedState<AgentSlices>;
