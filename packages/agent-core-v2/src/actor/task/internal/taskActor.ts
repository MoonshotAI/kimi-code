import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import type {
  AgentRuntimeContext,
  AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';

import type { TaskModelState } from '../taskOps';
import { createTaskLifecycle, type TaskLifecycle } from './taskLifecycle';

export interface TaskActorContext {
  readonly runtime: AgentRuntimeContext<TaskModelState>;
  readonly lifecycle: TaskLifecycle;
  readonly registry: TaskModelState;
}

interface TaskCommitEvent {
  readonly type: 'task.commit';
  readonly registry: TaskModelState;
}

export type TaskActorSnapshot = Snapshot<unknown> & {
  readonly context: TaskActorContext;
};

const taskEffects = fromCallback(({ input }: { input: TaskLifecycle }) => {
  return () => {
    input.shutdown();
  };
});

export const taskActorLogic = setup({
  types: {} as {
    context: TaskActorContext;
    input: AgentRuntimeContext<TaskModelState>;
    events: TaskCommitEvent | AgentRuntimeRestoreEvent;
  },
  actors: { taskEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    lifecycle: createTaskLifecycle(input),
    registry: new Map(),
  }),
  initial: 'beforeRestore',
  invoke: {
    src: 'taskEffects',
    input: ({ context }) => context.lifecycle,
  },
  states: {
    beforeRestore: {
      on: {
        'runtime.restore': {
          target: 'active',
          actions: ({ context, event }) => {
            event.waitUntil(context.lifecycle.beginRestore());
          },
        },
      },
    },
    active: {},
  },
  on: {
    'task.commit': {
      actions: assign({ registry: ({ event }) => event.registry }),
    },
  },
});
