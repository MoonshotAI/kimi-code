import { assign, emit, fromCallback, fromPromise, setup } from '#/xstate2/index';

import type { ToolCall } from '#/llm/message';
import type { ToolExecutor, ToolInput, ToolResult, ToolUpdate } from '#/tool';

export type ToolEvent =
  | { type: 'tool.update'; toolCallId: string; update: ToolUpdate }
  | { type: 'tool.detached'; toolCallId: string; text: string }
  | { type: 'tool.done'; toolCallId: string; outcome: ToolOutput }
  | { type: 'tool.abort' };

export type ToolOutput =
  | { type: 'succeeded'; result: ToolResult }
  | { type: 'failed'; error: unknown }
  | { type: 'aborted'; reason?: unknown };

export interface ToolBeforeInput {
  toolCall: ToolCall;
  toolCalls: readonly ToolCall[];
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
          detach: (text) => {
            if (detached) return;
            detached = true;
            sendBack({ type: 'tool.detached', toolCallId, text });
          },
        });
        sendBack({ type: 'tool.done', toolCallId, outcome: { type: 'succeeded', result } });
      } catch (error) {
        sendBack({
          type: 'tool.done',
          toolCallId,
          outcome: input.signal.aborted ? { type: 'aborted', reason: input.signal.reason } : { type: 'failed', error },
        });
      }
    })();
  });
}

export interface CreateToolMachineOptions extends ToolExecutor {
  readonly onBefore?: (input: ToolBeforeInput) => Promise<ToolBeforeDecision> | ToolBeforeDecision;
  readonly onAfter?: (input: ToolAfterInput) => Promise<ToolResult> | ToolResult;
}

export function createToolMachine(executor: CreateToolMachineOptions) {
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
        async ({ input }) =>
          executor.onBefore?.(input) ?? { type: 'proceed', toolCall: input.toolCall },
      ),
      executeActor,
      finishingActor: fromPromise<ToolResult, ToolAfterInput>(
        async ({ input }) => executor.onAfter?.(input) ?? input.result,
      ),
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
          input: ({ context }) => ({
            toolCall: context.toolCall,
            toolCalls: context.input.toolCalls ?? [context.toolCall],
          }),
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
                type: 'tool.done' as const,
                toolCallId: context.toolCall.id,
                outcome: { type: 'failed' as const, error: event.error },
              })),
              ({ self, context, event }) => {
                self._parent?.send({
                  type: 'tool.done',
                  toolCallId: context.toolCall.id,
                  outcome: { type: 'failed', error: event.error },
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
                type: 'tool.done' as const,
                toolCallId: context.toolCall.id,
                outcome: { type: 'aborted' as const, reason: context.input.signal.reason },
              })),
              ({ self, context }) => {
                self._parent?.send({
                  type: 'tool.done',
                  toolCallId: context.toolCall.id,
                  outcome: { type: 'aborted', reason: context.input.signal.reason },
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
          'tool.done': [
            {
              guard: ({ event }) => event.outcome.type === 'succeeded',
              target: 'finishing',
              actions: assign({
                result: ({ event }) => (event.outcome as { result: ToolResult }).result,
              }),
            },
            {
              guard: ({ event }) => event.outcome.type === 'failed',
              target: 'failed',
              actions: [
                assign({
                  outcome: 'failed' as const,
                  error: ({ event }) => (event.outcome as { error: unknown }).error,
                }),
                emit(({ event }) => event),
                'forwardToParent',
              ],
            },
            {
              target: 'aborted',
              actions: [
                assign({ outcome: 'aborted' as const }),
                emit(({ event }) => event),
                'forwardToParent',
              ],
            },
          ],
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
                outcome: { type: 'succeeded' as const, result: event.output },
              })),
              ({ self, context, event }) => {
                self._parent?.send({
                  type: 'tool.done',
                  toolCallId: context.toolCall.id,
                  outcome: { type: 'succeeded', result: event.output },
                });
              },
            ],
          },
          onError: {
            target: 'failed',
            actions: [
              assign({ outcome: 'failed', error: ({ event }) => event.error }),
              emit(({ context, event }) => ({
                type: 'tool.done' as const,
                toolCallId: context.toolCall.id,
                outcome: { type: 'failed' as const, error: event.error },
              })),
              ({ self, context, event }) => {
                self._parent?.send({
                  type: 'tool.done',
                  toolCallId: context.toolCall.id,
                  outcome: { type: 'failed', error: event.error },
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
          ? { type: 'aborted', reason: context.input.signal.reason }
          : { type: 'succeeded', result: context.result as ToolResult },
  });
}
