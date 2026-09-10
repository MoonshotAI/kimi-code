import { assign, emit, fromCallback, fromPromise, setup } from '#/xstate2';

import type { ToolCall } from '#/llm/message';

import type { TaskWaitInput, TaskWaitOutcome, ToolExecutor, ToolResult, ToolUpdate } from './executor';

export interface ToolInput {
  toolCall: ToolCall;
  signal: AbortSignal;
  waitForTasks?: (input: TaskWaitInput) => Promise<TaskWaitOutcome>;
}

export type ToolEvent =
  | { type: 'tool.update'; toolCallId: string; update: ToolUpdate }
  | { type: 'tool.detached'; toolCallId: string; text: string }
  | { type: 'tool.done'; toolCallId: string; result: ToolResult }
  | { type: 'tool.failed'; toolCallId: string; error: unknown }
  | { type: 'tool.aborted'; toolCallId: string }
  | { type: 'tool.abort' };

export type ToolOutput =
  | { type: 'succeeded'; result: ToolResult }
  | { type: 'failed'; error: unknown }
  | { type: 'aborted' };

export interface ToolBeforeInput {
  toolCall: ToolCall;
}

export type ToolBeforeDecision =
  | { type: 'proceed'; toolCall?: ToolCall }
  | { type: 'denied'; result: ToolResult };

export interface ToolAfterInput {
  toolCall: ToolCall;
  result: ToolResult;
}

export interface ToolMachineContext {
  input: ToolInput;
  toolCall: ToolCall;
  outcome?: 'succeeded' | 'failed' | 'aborted';
  result?: ToolResult;
  error?: unknown;
}

function createExecuteActor(executor: ToolExecutor) {
  return fromCallback<ToolEvent, ToolInput>(({ input, sendBack }) => {
    const toolCallId = input.toolCall.id;
    let detached = false;
    void (async () => {
      try {
        const result = await executor.execute({
          toolCall: input.toolCall,
          signal: input.signal,
          onUpdate: (update) => sendBack({ type: 'tool.update', toolCallId, update }),
          detach: (ack) => {
            if (detached) return;
            detached = true;
            sendBack({ type: 'tool.detached', toolCallId, text: ack.text });
          },
          waitForTasks: input.waitForTasks,
        });
        sendBack({ type: 'tool.done', toolCallId, result });
      } catch (error) {
        sendBack(
          input.signal.aborted
            ? { type: 'tool.aborted', toolCallId }
            : { type: 'tool.failed', toolCallId, error },
        );
      }
    })();
  });
}

export function createToolMachine(executor: ToolExecutor) {
  const executeActor = createExecuteActor(executor);
  return setup({
    types: {
      input: {} as ToolInput,
      context: {} as ToolMachineContext,
      events: {} as ToolEvent,
      emitted: {} as ToolEvent,
      output: {} as ToolOutput,
    },
    actors: {
      preparingActor: fromPromise<ToolBeforeDecision, ToolBeforeInput>(
        async ({ input }) => ({ type: 'proceed', toolCall: input.toolCall }),
      ),
      executeActor,
      finishingActor: fromPromise<ToolResult, ToolAfterInput>(async ({ input }) => input.result),
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
    },
  }).createMachine({
    id: 'tool',
    initial: 'preparing',
    context: ({ input }) => ({ input, toolCall: input.toolCall }),
    states: {
      preparing: {
        invoke: {
          src: 'preparingActor',
          input: ({ context }) => ({ toolCall: context.toolCall }),
          onDone: [
            {
              guard: ({ event }) => event.output.type === 'denied',
              target: 'finishing',
              actions: assign({
                result: ({ event }) => (event.output as { result: ToolResult }).result,
              }),
            },
            {
              target: 'executing',
              actions: assign({
                toolCall: ({ context, event }) =>
                  (event.output as { toolCall?: ToolCall }).toolCall ?? context.toolCall,
              }),
            },
          ],
          onError: {
            target: 'failed',
            actions: [
              assign({ outcome: 'failed', error: ({ event }) => event.error }),
              emit(({ context, event }) => ({
                type: 'tool.failed' as const,
                toolCallId: context.toolCall.id,
                error: event.error,
              })),
              ({ self, context, event }) => {
                self._parent?.send({
                  type: 'tool.failed',
                  toolCallId: context.toolCall.id,
                  error: event.error,
                });
              },
            ],
          },
        },
        on: {
          'tool.abort': {
            target: 'aborted',
            actions: [
              assign({ outcome: 'aborted' as const }),
              emit(({ context }) => ({
                type: 'tool.aborted' as const,
                toolCallId: context.toolCall.id,
              })),
              ({ self, context }) => {
                self._parent?.send({
                  type: 'tool.aborted',
                  toolCallId: context.toolCall.id,
                });
              },
            ],
          },
        },
      },
      executing: {
        invoke: {
          src: 'executeActor',
          input: ({ context }) => ({
            toolCall: context.toolCall,
            signal: context.input.signal,
            waitForTasks: context.input.waitForTasks,
          }),
        },
        on: {
          'tool.abort': {},
          'tool.update': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'tool.detached': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'tool.done': {
            target: 'finishing',
            actions: assign({ result: ({ event }) => event.result }),
          },
          'tool.failed': {
            target: 'failed',
            actions: [
              assign({ outcome: 'failed', error: ({ event }) => event.error }),
              emit(({ event }) => event),
              'forwardToParent',
            ],
          },
          'tool.aborted': {
            target: 'aborted',
            actions: [
              assign({ outcome: 'aborted' as const }),
              emit(({ event }) => event),
              'forwardToParent',
            ],
          },
        },
      },
      finishing: {
        invoke: {
          src: 'finishingActor',
          input: ({ context }) => ({
            toolCall: context.toolCall,
            result: context.result as ToolResult,
          }),
          onDone: {
            target: 'succeeded',
            actions: [
              assign({ outcome: 'succeeded', result: ({ event }) => event.output }),
              emit(({ context, event }) => ({
                type: 'tool.done' as const,
                toolCallId: context.toolCall.id,
                result: event.output,
              })),
              ({ self, context, event }) => {
                self._parent?.send({
                  type: 'tool.done',
                  toolCallId: context.toolCall.id,
                  result: event.output,
                });
              },
            ],
          },
          onError: {
            target: 'failed',
            actions: [
              assign({ outcome: 'failed', error: ({ event }) => event.error }),
              emit(({ context, event }) => ({
                type: 'tool.failed' as const,
                toolCallId: context.toolCall.id,
                error: event.error,
              })),
              ({ self, context, event }) => {
                self._parent?.send({
                  type: 'tool.failed',
                  toolCallId: context.toolCall.id,
                  error: event.error,
                });
              },
            ],
          },
        },
      },
      succeeded: { type: 'final' },
      failed: { type: 'final' },
      aborted: { type: 'final' },
    },
    output: ({ context }): ToolOutput =>
      context.outcome === 'failed'
        ? { type: 'failed', error: context.error }
        : context.outcome === 'aborted'
          ? { type: 'aborted' }
          : { type: 'succeeded', result: context.result as ToolResult },
  });
}
