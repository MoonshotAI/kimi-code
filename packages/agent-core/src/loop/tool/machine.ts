import { assign, enqueueActions, fromCallback, sendParent, setup, type ActorRefFrom } from 'xstate';

import type { ToolCall } from '#/llm/message';
import { errorText } from '#/llm/protocol/errors';
import {
  isToolExecutorHost,
  isToolResult,
  type ToolExecutor,
  type ToolHookFailure,
  type ToolHookPoint,
  type ToolResult,
  type ToolUpdate,
} from '#/tool/index';
import { toolExecutionFailureOf } from '#/tool/executor';
import { withAbort, type AbortScope } from '#/utils/abort';
import type { ToolEvent } from '../contract/emitted';
import type { AsyncToolOutcome, ToolCallOutcome } from '../contract/outcome';
import { hookFailedEvent } from '../hook/failure';
import { blockedToolOutcome, completionEntry, errorResult, toolEntry } from './outcome';

type ExecOutput =
  | { type: 'succeeded'; result: ToolResult }
  | { type: 'failed'; error: unknown; result?: ToolResult }
  | { type: 'aborted'; reason?: unknown };

export type ToolActorEvent =
  | { type: 'tool.abort'; reason?: unknown }
  | { type: 'tool.detach'; text?: string }
  | { type: 'exec.adjudicated'; toolCall: ToolCall }
  | { type: 'exec.hook_failed'; point: ToolHookPoint; failure: ToolHookFailure }
  | { type: 'exec.update'; update: ToolUpdate }
  | { type: 'exec.done'; output: ExecOutput };

export type ToolSignal = ToolEvent & { key: string };

type ToolStatus = 'succeeded' | 'failed' | 'aborted';

export interface ToolMachineInput {
  key: string;
  toolCall: ToolCall;
  turnId: number;
  step: number;
  signal: AbortSignal;
}

export interface ToolMachineContext {
  input: ToolMachineInput;
  toolCall: ToolCall;
  scope: AbortScope;
  detached: boolean;
  status?: ToolStatus;
  result?: ToolResult;
  error?: unknown;
  reason?: unknown;
}

function failedPatch(error: unknown, result?: ToolResult): Partial<ToolMachineContext> {
  return { status: 'failed', error, result: result ?? errorResult(errorText(error)) };
}

function abortedPatch(reason: unknown): Partial<ToolMachineContext> {
  return { status: 'aborted', reason, result: errorResult('aborted') };
}

function execPatch(output: ExecOutput): Partial<ToolMachineContext> {
  if (output.type === 'succeeded') return { status: 'succeeded', result: output.result };
  if (output.type === 'aborted') return abortedPatch(output.reason);
  return failedPatch(output.error, output.result);
}

function outcomeOf(context: ToolMachineContext): ToolCallOutcome {
  const result = context.result ?? errorResult('missing tool result');
  if (result.blocked !== undefined) return blockedToolOutcome(context.toolCall, result.blocked, result);
  const stops = context.status !== 'aborted' && result.stopTurn === true;
  const entry = toolEntry(context.toolCall, stops ? { ...result, stopTurn: true } : result);
  switch (context.status) {
    case 'succeeded':
      return stops ? { type: 'succeeded', entry, stopTurn: true } : { type: 'succeeded', entry };
    case 'aborted':
      return { type: 'aborted', entry, reason: context.reason };
    default:
      return { type: 'failed', entry, error: context.error };
  }
}

function asyncOutcomeOf(context: ToolMachineContext): AsyncToolOutcome {
  if (context.status === 'succeeded') return { type: 'succeeded' };
  if (context.status === 'aborted') return { type: 'aborted', reason: context.reason };
  return { type: 'failed', error: context.error };
}

function createExecuteActor(executor: ToolExecutor) {
  return fromCallback<ToolActorEvent, ToolMachineInput>(({ input, sendBack }) => {
    Promise.resolve()
      .then(() =>
        executor.execute({
          toolCall: input.toolCall,
          signal: input.signal,
          turnId: input.turnId,
          step: input.step,
          onAdjudicated: (toolCall) => sendBack({ type: 'exec.adjudicated', toolCall }),
          onHookFailure: (point, failure) => sendBack({ type: 'exec.hook_failed', point, failure }),
          onUpdate: (update) => sendBack({ type: 'exec.update', update }),
          detach: (text) => sendBack({ type: 'tool.detach', text }),
        }),
      )
      .then(
        (result: unknown) =>
          sendBack({
            type: 'exec.done',
            output: isToolResult(result)
              ? { type: 'succeeded', result }
              : { type: 'failed', error: new Error('invalid tool result') },
          }),
        (error: unknown) => {
          const failure = toolExecutionFailureOf(error);
          sendBack({
            type: 'exec.done',
            output: input.signal.aborted
              ? { type: 'aborted', reason: input.signal.reason }
              : { type: 'failed', error: failure?.error ?? error, result: failure?.result },
          });
        },
      );
  });
}

export function createToolMachine(executor: ToolExecutor) {
  const adjudicates = isToolExecutorHost(executor);
  return setup({
    types: {
      input: {} as ToolMachineInput,
      context: {} as ToolMachineContext,
      events: {} as ToolActorEvent,
    },
    actors: {
      executeActor: createExecuteActor(executor),
    },
  }).createMachine({
    id: 'tool',
    initial: 'started',
    context: ({ input }) => ({
      input,
      toolCall: input.toolCall,
      scope: withAbort(input.signal),
      detached: false,
    }),
    states: {
      started: {
        entry: enqueueActions(({ context, enqueue }) => {
          if (adjudicates) return;
          enqueue.sendParent({
            type: 'tool.started',
            key: context.input.key,
            turnId: context.input.turnId,
            step: context.input.step,
            toolCall: context.toolCall,
          });
        }),
        always: 'executing',
      },
      executing: {
        invoke: {
          src: 'executeActor',
          input: ({ context }) => ({ ...context.input, signal: context.scope.signal }),
          onError: {
            target: 'done',
            actions: assign(({ event }) => failedPatch(event.error)),
          },
        },
        on: {
          'exec.adjudicated': {
            actions: [
              assign(({ event }) => ({ toolCall: event.toolCall })),
              sendParent(({ context, event }) => ({
                type: 'tool.started',
                key: context.input.key,
                turnId: context.input.turnId,
                step: context.input.step,
                toolCall: event.toolCall,
              })),
            ],
          },
          'exec.hook_failed': {
            actions: sendParent(({ context, event }) =>
              hookFailedEvent(event.point, context.input.turnId, context.input.step, event.failure),
            ),
          },
          'exec.update': {
            guard: ({ context }) => !context.detached,
            actions: sendParent(({ context, event }) => ({
              type: 'tool.delta',
              key: context.input.key,
              toolCallId: context.toolCall.id,
              update: event.update,
            })),
          },
          'tool.detach': {
            guard: ({ context }) => !context.detached,
            actions: [
              assign({ detached: true }),
              sendParent(({ context, event }) => ({
                type: 'tool.ended',
                key: context.input.key,
                toolCallId: context.toolCall.id,
                outcome: {
                  type: 'succeeded',
                  entry: toolEntry(
                    context.toolCall,
                    {
                      content: [
                        {
                          type: 'text',
                          text:
                            event.text === undefined || event.text === ''
                              ? `async running: ${context.toolCall.name}`
                              : event.text,
                        },
                      ],
                    },
                    true,
                  ),
                },
                detached: true,
              })),
            ],
          },
          'tool.abort': {
            actions: ({ context, event }) => {
              context.scope.abort(event.reason);
            },
          },
          'exec.done': {
            target: 'done',
            actions: assign(({ event }) => execPatch(event.output)),
          },
        },
      },
      done: {
        type: 'final',
        entry: enqueueActions(({ context, enqueue }) => {
          if (context.detached) {
            const outcome = asyncOutcomeOf(context);
            enqueue.sendParent({
              type: 'tool.async_ended',
              key: context.input.key,
              toolCallId: context.toolCall.id,
              outcome,
              entry: completionEntry(context.toolCall, outcome, context.result),
            });
            return;
          }
          enqueue.sendParent({
            type: 'tool.ended',
            key: context.input.key,
            toolCallId: context.toolCall.id,
            outcome: outcomeOf(context),
            detached: false,
          });
        }),
      },
    },
  });
}

export type ToolActorRef = ActorRefFrom<ReturnType<typeof createToolMachine>>;
