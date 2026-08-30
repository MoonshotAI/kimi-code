import { assign, fromPromise, setup, type ActorRefFrom, type ErrorActorEvent } from 'xstate';

import type { ToolCall } from '#/kosong/contract/message';
import type { ToolAccesses } from '#/tool/toolContract';
import type {
  ToolExecutionResult,
  ToolExecutorExecuteOptions,
} from '#/actor/toolExecutor/toolExecutor';
import {
  finalizeToolCall,
  prepareSkippedToolCall,
  prepareToolCall,
  runPreparedTask,
  type PreflightedToolCall,
  type PreparedCall,
  type TimedToolResult,
  type ToolCallPipelineDeps,
} from '#/actor/toolExecutor/internal/executor';

export interface ToolCallInput {
  readonly deps: ToolCallPipelineDeps;
  readonly batchId: number;
  readonly index: number;
  readonly call: PreflightedToolCall;
  readonly calls: readonly ToolCall[];
  readonly options: ToolExecutorExecuteOptions;
}

export interface ToolCallContext extends ToolCallInput {
  prepared: PreparedCall | undefined;
  timed: TimedToolResult | undefined;
}

export interface ToolCallPreparedNotice {
  readonly type: 'toolExecutor.call.prepared';
  readonly batchId: number;
  readonly index: number;
  readonly accesses: ToolAccesses;
  readonly stopBatchAfterThis: boolean;
}

export interface ToolCallRanNotice {
  readonly type: 'toolExecutor.call.ran';
  readonly batchId: number;
  readonly index: number;
}

export interface ToolCallSettledNotice {
  readonly type: 'toolExecutor.call.settled';
  readonly batchId: number;
  readonly index: number;
  readonly result: ToolExecutionResult;
}

export interface ToolCallFailedNotice {
  readonly type: 'toolExecutor.call.failed';
  readonly batchId: number;
  readonly index: number;
  readonly error: unknown;
}

export type ToolCallParentNotice =
  | ToolCallPreparedNotice
  | ToolCallRanNotice
  | ToolCallSettledNotice
  | ToolCallFailedNotice;

type ToolCallCommand =
  | { readonly type: 'call.prepare' }
  | { readonly type: 'call.skip' }
  | { readonly type: 'call.start' };

const prepareCall = fromPromise(({ input }: { input: ToolCallContext }) =>
  prepareToolCall(input.deps, input.call, input.calls, input.options),
);

const runCall = fromPromise(({ input }: { input: ToolCallContext }) =>
  runPreparedTask(input.prepared!.task, input.options.signal),
);

const finalizeCall = fromPromise(({ input }: { input: ToolCallContext }) =>
  finalizeToolCall(
    input.deps,
    input.call,
    input.timed!,
    input.options,
    input.prepared!.resolvedAccesses,
  ),
);

export const toolCallLogic = setup({
  types: {} as {
    context: ToolCallContext;
    input: ToolCallInput;
    events: ToolCallCommand;
  },
  actors: { prepareCall, runCall, finalizeCall },
  actions: {
    applySkip: assign(({ context }) => ({
      prepared: prepareSkippedToolCall(context.deps.runtime, context.call, context.options),
    })),
    reportPrepared: ({ context }) => {
      context.deps.runtime.send({
        type: 'toolExecutor.call.prepared',
        batchId: context.batchId,
        index: context.index,
        accesses: context.prepared!.task.accesses,
        stopBatchAfterThis: context.prepared!.stopBatchAfterThis === true,
      } satisfies ToolCallPreparedNotice);
    },
    reportRan: ({ context }) => {
      context.deps.runtime.send({
        type: 'toolExecutor.call.ran',
        batchId: context.batchId,
        index: context.index,
      } satisfies ToolCallRanNotice);
    },
    reportFailed: ({ context, event }) => {
      context.deps.runtime.send({
        type: 'toolExecutor.call.failed',
        batchId: context.batchId,
        index: context.index,
        error: (event as unknown as ErrorActorEvent).error,
      } satisfies ToolCallFailedNotice);
    },
  },
}).createMachine({
  context: ({ input }) => ({ ...input, prepared: undefined, timed: undefined }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        'call.prepare': { target: 'preparing' },
        'call.skip': { target: 'ready', actions: 'applySkip' },
      },
    },
    preparing: {
      invoke: {
        src: 'prepareCall',
        input: ({ context }) => context,
        onDone: {
          target: 'ready',
          actions: assign({ prepared: ({ event }) => event.output }),
        },
        onError: { target: 'failed', actions: 'reportFailed' },
      },
    },
    ready: {
      entry: 'reportPrepared',
      on: {
        'call.start': { target: 'running' },
      },
    },
    running: {
      invoke: {
        src: 'runCall',
        input: ({ context }) => context,
        onDone: {
          target: 'finalizing',
          actions: [assign({ timed: ({ event }) => event.output }), 'reportRan'],
        },
        onError: { target: 'failed', actions: 'reportFailed' },
      },
    },
    finalizing: {
      invoke: {
        src: 'finalizeCall',
        input: ({ context }) => context,
        onDone: {
          target: 'settled',
          actions: ({ context, event }) => {
            context.deps.runtime.send({
              type: 'toolExecutor.call.settled',
              batchId: context.batchId,
              index: context.index,
              result: event.output,
            } satisfies ToolCallSettledNotice);
          },
        },
        onError: { target: 'failed', actions: 'reportFailed' },
      },
    },
    settled: { type: 'final' },
    failed: { type: 'final' },
  },
});

export type ToolCallActorRef = ActorRefFrom<typeof toolCallLogic>;
