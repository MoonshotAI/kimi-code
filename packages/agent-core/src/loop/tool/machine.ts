import { assign, enqueueActions, fromCallback, fromPromise, sendParent, setup, type ActorRefFrom } from 'xstate';

import type { ToolCall } from '#/llm/message';
import { errorText } from '#/llm/protocol/errors';
import type { ToolExecutor, ToolResult, ToolUpdate } from '#/tool/index';
import { withAbort, type AbortScope } from '#/utils/abort';
import type { ToolEvent } from '../contract/emitted';
import type { HookPoint, ToolEndingEvent, ToolStartingEvent } from '../contract/hook';
import type { AsyncToolOutcome, Cause, ToolCallOutcome } from '../contract/outcome';
import { isToolResult } from '../guards';
import { hookFailedEvent, hookFailureCause, hookFailureText, type HookFailure } from '../hook/failure';
import type { HookSource } from '../hook/registry';
import { runToolEnding, runToolPermitting, runToolStarting, type ToolEndingRun, type ToolStartingRun } from '../hook/run';
import { blockedToolOutcome, completionEntry, errorResult, toolEntry, withNotes } from './outcome';

type ExecOutput =
  | { type: 'succeeded'; result: ToolResult }
  | { type: 'failed'; error: unknown }
  | { type: 'aborted'; reason?: unknown };

export type ToolActorEvent =
  | { type: 'tool.abort'; reason?: unknown }
  | { type: 'tool.detach'; text?: string }
  | { type: 'exec.update'; update: ToolUpdate }
  | { type: 'exec.done'; output: ExecOutput };

export type ToolSignal = ToolEvent & { key: string };

type ToolStatus = 'succeeded' | 'failed' | 'aborted' | 'blocked';

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
  cause?: Cause;
  stopTurn?: true;
  notes: string[];
}

function causeText(cause: Cause): string {
  return cause.message ?? cause.reason;
}

function failedPatch(error: unknown): Partial<ToolMachineContext> {
  return { status: 'failed', error, result: errorResult(errorText(error)) };
}

function abortedPatch(reason: unknown): Partial<ToolMachineContext> {
  return { status: 'aborted', reason, result: errorResult('aborted') };
}

function execPatch(output: ExecOutput): Partial<ToolMachineContext> {
  if (output.type === 'succeeded') return { status: 'succeeded', result: output.result };
  if (output.type === 'aborted') return abortedPatch(output.reason);
  return failedPatch(output.error);
}

function outcomeOf(context: ToolMachineContext): ToolCallOutcome {
  const result = withNotes(context.result ?? errorResult('missing tool result'), context.notes);
  if (context.status === 'blocked') {
    return blockedToolOutcome(context.toolCall, context.cause ?? { reason: 'blocked' }, result);
  }
  const stops = context.status === 'succeeded' && (context.stopTurn === true || result.stopTurn === true);
  const entry = toolEntry(context.toolCall, { ...result, stopTurn: stops });
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
  return fromCallback<ToolActorEvent, { toolCall: ToolCall; signal: AbortSignal }>(
    ({ input, sendBack }) => {
      Promise.resolve()
        .then(() =>
          executor.execute({
            toolCall: input.toolCall,
            signal: input.signal,
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
          (error: unknown) =>
            sendBack({
              type: 'exec.done',
              output: input.signal.aborted
                ? { type: 'aborted', reason: input.signal.reason }
                : { type: 'failed', error },
            }),
        );
    },
  );
}

export function createToolMachine(executor: ToolExecutor, hooks: HookSource) {
  return setup({
    types: {
      input: {} as ToolMachineInput,
      context: {} as ToolMachineContext,
      events: {} as ToolActorEvent,
    },
    actors: {
      executeActor: createExecuteActor(executor),
      startingActor: fromPromise<ToolStartingRun, { event: ToolStartingEvent; signal: AbortSignal }>(
        ({ input }) => runToolStarting(hooks, input.event, input.signal),
      ),
      permittingActor: fromPromise<ToolStartingRun, { event: ToolStartingEvent; signal: AbortSignal }>(
        ({ input }) => runToolPermitting(hooks, input.event, input.signal),
      ),
      endingActor: fromPromise<ToolEndingRun, { event: ToolEndingEvent; signal: AbortSignal }>(
        ({ input }) => runToolEnding(hooks, input.event, input.signal),
      ),
    },
    actions: {
      reportFailures: enqueueActions(
        ({ context, enqueue }, params: { point: HookPoint; failures: readonly HookFailure[] }) => {
          const notes = params.failures
            .filter((failure) => !failure.blocking)
            .map((failure) => hookFailureText(params.point, failure.error));
          if (notes.length > 0) enqueue.assign({ notes: [...context.notes, ...notes] });
          for (const failure of params.failures) {
            enqueue.sendParent(hookFailedEvent(params.point, context.input.turnId, context.input.step, failure));
          }
        },
      ),
    },
  }).createMachine({
    id: 'tool',
    initial: 'starting',
    context: ({ input }) => ({
      input,
      toolCall: input.toolCall,
      scope: withAbort(input.signal),
      detached: false,
      notes: [],
    }),
    states: {
      starting: {
        invoke: {
          src: 'startingActor',
          input: ({ context }) => ({
            event: { turnId: context.input.turnId, step: context.input.step, toolCall: context.toolCall },
            signal: context.scope.signal,
          }),
          onDone: [
            {
              guard: ({ event }) => event.output.blocked !== undefined,
              target: 'started',
              actions: [
                assign(({ event }) => {
                  const { toolCall, blocked, result } = event.output;
                  const cause = blocked ?? { reason: 'blocked' };
                  return {
                    toolCall,
                    status: 'blocked' as const,
                    cause,
                    result: { ...(result ?? errorResult(causeText(cause))), isError: true as const },
                  };
                }),
                {
                  type: 'reportFailures',
                  params: ({ event }) => ({ point: 'tool.starting' as const, failures: event.output.failures }),
                },
              ],
            },
            {
              target: 'permitting',
              actions: [
                assign(({ event }) => ({ toolCall: event.output.toolCall })),
                {
                  type: 'reportFailures',
                  params: ({ event }) => ({ point: 'tool.starting' as const, failures: event.output.failures }),
                },
              ],
            },
          ],
          onError: {
            target: 'started',
            actions: [
              assign(({ event }) => {
                const cause = hookFailureCause('tool.starting', event.error);
                return { status: 'blocked' as const, cause, result: errorResult(causeText(cause)) };
              }),
              {
                type: 'reportFailures',
                params: ({ event }) => ({
                  point: 'tool.starting' as const,
                  failures: [{ error: event.error, paused: false, blocking: true }],
                }),
              },
            ],
          },
        },
        on: {
          'tool.abort': {
            target: 'started',
            actions: assign(({ event }) => abortedPatch(event.reason)),
          },
        },
      },
      permitting: {
        invoke: {
          src: 'permittingActor',
          input: ({ context }) => ({
            event: { turnId: context.input.turnId, step: context.input.step, toolCall: context.toolCall },
            signal: context.scope.signal,
          }),
          onDone: {
            target: 'started',
            actions: [
              assign(({ event }) => {
                const { toolCall, blocked, result } = event.output;
                if (blocked === undefined) return { toolCall };
                return {
                  toolCall,
                  status: 'blocked' as const,
                  cause: blocked,
                  result: { ...(result ?? errorResult(causeText(blocked))), isError: true as const },
                };
              }),
              {
                type: 'reportFailures',
                params: ({ event }) => ({ point: 'tool.permitting' as const, failures: event.output.failures }),
              },
            ],
          },
          onError: {
            target: 'started',
            actions: [
              assign(({ event }) => {
                const cause = hookFailureCause('tool.permitting', event.error);
                return { status: 'blocked' as const, cause, result: errorResult(causeText(cause)) };
              }),
              {
                type: 'reportFailures',
                params: ({ event }) => ({
                  point: 'tool.permitting' as const,
                  failures: [{ error: event.error, paused: false, blocking: true }],
                }),
              },
            ],
          },
        },
        on: {
          'tool.abort': {
            target: 'started',
            actions: assign(({ event }) => abortedPatch(event.reason)),
          },
        },
      },
      started: {
        entry: sendParent(({ context }) => ({
          type: 'tool.started',
          key: context.input.key,
          turnId: context.input.turnId,
          step: context.input.step,
          toolCall: context.toolCall,
        })),
        always: [
          { guard: ({ context }) => context.status !== undefined, target: 'done' },
          { target: 'executing' },
        ],
      },
      executing: {
        invoke: {
          src: 'executeActor',
          input: ({ context }) => ({ toolCall: context.toolCall, signal: context.scope.signal }),
          onError: [
            {
              guard: ({ context }) => context.detached,
              target: 'done',
              actions: assign(({ event }) => failedPatch(event.error)),
            },
            {
              target: 'ending',
              actions: assign(({ event }) => failedPatch(event.error)),
            },
          ],
        },
        on: {
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
          'exec.done': [
            {
              guard: ({ context, event }) => context.detached || event.output.type === 'aborted',
              target: 'done',
              actions: assign(({ event }) => execPatch(event.output)),
            },
            {
              target: 'ending',
              actions: assign(({ event }) => execPatch(event.output)),
            },
          ],
        },
      },
      ending: {
        invoke: {
          src: 'endingActor',
          input: ({ context }) => ({
            event: {
              turnId: context.input.turnId,
              step: context.input.step,
              toolCall: context.toolCall,
              result: context.result ?? errorResult('missing tool result'),
              failed: context.status === 'failed',
            },
            signal: context.scope.signal,
          }),
          onDone: {
            target: 'done',
            actions: [
              assign(({ event }) => ({
                result: event.output.result,
                stopTurn: event.output.stopTurn ? (true as const) : undefined,
              })),
              {
                type: 'reportFailures',
                params: ({ event }) => ({ point: 'tool.ending' as const, failures: event.output.failures }),
              },
            ],
          },
          onError: {
            target: 'done',
            actions: {
              type: 'reportFailures',
              params: ({ event }) => ({
                point: 'tool.ending' as const,
                failures: [{ error: event.error, paused: false, blocking: false }],
              }),
            },
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
              entry: completionEntry(
                context.toolCall,
                outcome,
                context.result === undefined ? undefined : withNotes(context.result, context.notes),
              ),
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
