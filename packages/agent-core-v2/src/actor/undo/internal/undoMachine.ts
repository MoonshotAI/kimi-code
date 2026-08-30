import { assign, fromPromise, setup } from 'xstate';

import type { AgentRuntimeContext } from '#/actor/agentRuntime';

import type { AgentConversationUndoParticipant, UndoResult } from '../undoAgentRuntime';

import { runUndo } from './undoOperations';

export interface UndoRequestEntry {
  readonly count: number;
  readonly resolve: (result: UndoResult) => void;
  readonly reject: (error: unknown) => void;
}

export interface UndoActorContext {
  readonly runtime: AgentRuntimeContext<null>;
  readonly participants: ReadonlyMap<string, AgentConversationUndoParticipant>;
  readonly queue: readonly UndoRequestEntry[];
  readonly current: UndoRequestEntry | undefined;
}

export interface UndoRequestedEvent {
  readonly type: 'undo.requested';
  readonly request: UndoRequestEntry;
}

export interface UndoParticipantRegisteredEvent {
  readonly type: 'undo.participantRegistered';
  readonly participant: AgentConversationUndoParticipant;
}

export interface UndoParticipantUnregisteredEvent {
  readonly type: 'undo.participantUnregistered';
  readonly id: string;
  readonly participant: AgentConversationUndoParticipant;
}

export type UndoActorEvent =
  | UndoRequestedEvent
  | UndoParticipantRegisteredEvent
  | UndoParticipantUnregisteredEvent;

function participantsWith(
  participants: ReadonlyMap<string, AgentConversationUndoParticipant>,
  participant: AgentConversationUndoParticipant,
): ReadonlyMap<string, AgentConversationUndoParticipant> {
  const next = new Map(participants);
  next.set(participant.id, participant);
  return next;
}

function participantsWithout(
  participants: ReadonlyMap<string, AgentConversationUndoParticipant>,
  id: string,
  participant: AgentConversationUndoParticipant,
): ReadonlyMap<string, AgentConversationUndoParticipant> {
  if (participants.get(id) !== participant) return participants;
  const next = new Map(participants);
  next.delete(id);
  return next;
}

const performUndo = fromPromise(
  ({ input }: { input: { readonly runtime: AgentRuntimeContext<null>; readonly count: number } }) =>
    runUndo(input.runtime, input.count),
);

export const undoActorLogic = setup({
  types: {} as {
    context: UndoActorContext;
    input: AgentRuntimeContext<null>;
    events: UndoActorEvent;
  },
  actors: { performUndo },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    participants: new Map(),
    queue: [],
    current: undefined,
  }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        'undo.requested': {
          target: 'undoing',
          actions: assign({ current: ({ event }) => event.request }),
        },
      },
    },
    undoing: {
      invoke: {
        src: 'performUndo',
        input: ({ context }) => ({ runtime: context.runtime, count: context.current!.count }),
        onDone: {
          target: 'drain',
          actions: ({ context, event }) => {
            context.current!.resolve(event.output);
          },
        },
        onError: {
          target: 'drain',
          actions: ({ context, event }) => {
            context.current!.reject(event.error);
          },
        },
      },
      on: {
        'undo.requested': {
          actions: assign({ queue: ({ context, event }) => [...context.queue, event.request] }),
        },
      },
    },
    drain: {
      always: [
        {
          guard: ({ context }) => context.queue.length > 0,
          target: 'undoing',
          actions: assign(({ context }) => ({
            current: context.queue[0],
            queue: context.queue.slice(1),
          })),
        },
        {
          target: 'idle',
          actions: assign({ current: () => undefined }),
        },
      ],
    },
  },
  on: {
    'undo.participantRegistered': {
      actions: assign({
        participants: ({ context, event }) => participantsWith(context.participants, event.participant),
      }),
    },
    'undo.participantUnregistered': {
      actions: assign({
        participants: ({ context, event }) =>
          participantsWithout(context.participants, event.id, event.participant),
      }),
    },
  },
});
