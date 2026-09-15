import type { CombinedState, EventStore } from '#/eventStore/eventStore';
import { createSlice } from '#/eventStore/slice';
import type { BranchRef } from '#/store/types';

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
  initialState: () => [] as UserEntry[],
  reducers: {
    [inputSubmitted.type]: (draft, event: InputSubmitted) => {
      if ('entry' in event) {
        draft.push(createUserEntry(event.entry.message, { source: 'input', ...event.entry.meta }));
      } else {
        draft.push(createUserEntry(event.message, { source: 'input', promptId: event.id }));
      }
    },
    [inputCancelled.type]: (draft, event: InputCancelled) =>
      draft.filter((entry) => entry.meta?.promptId !== event.id),
    [inputSteered.type]: (draft, event: InputSteered) =>
      draft.filter((entry) => entry.meta?.promptId !== event.id),
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
      if ('entry' in event) {
        draft.push(createUserEntry(event.entry.message, { source: 'notify', ...event.entry.meta }));
      } else {
        draft.push(createUserEntry(event.message, { source: event.source ?? 'notify' }));
      }
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
      const kept = draft.filter((entry) => entry.meta?.key !== event.key);
      const payload = event.message;
      if ('message' in payload) {
        const meta = { source: 'reminder', key: event.key, ...payload.meta };
        kept.push(
          payload.message.role === 'system'
            ? createSystemEntry(payload.message, meta)
            : createUserEntry(payload.message, meta),
        );
      } else {
        kept.push(
          payload.role === 'system'
            ? createSystemEntry(payload, { source: 'reminder', key: event.key })
            : createUserEntry(payload, { source: 'reminder', key: event.key }),
        );
      }
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
