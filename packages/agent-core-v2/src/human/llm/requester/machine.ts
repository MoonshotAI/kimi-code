import { assign, emit, fromCallback, setup } from '#/xstate2';

import type { LlmErrorMessage } from '#/llm/errors';
import type { Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';

import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequester,
  LlmRequestEvent,
} from './requester';
import { withEmptyResponseGuard } from './empty-response';
import type {
  LlmRecovery,
  LlmRecoveryContext,
  LlmRecoveryProposal,
  LlmRecoveryRecord,
} from './recovery';
import {
  readRetryAfterMs,
  resolveMaxAttempts,
  retryBackoffDelay,
  retryErrorFields,
  shouldRetry,
  type LlmRetryOptions,
} from './retry';

export interface LlmInput {
  readonly config: LlmRequestConfig;
  readonly content: LlmRequestContent;
}

export interface MessageResolveContext {
  readonly model: LlmModel;
  readonly signal: AbortSignal;
}

export interface MessageResolver {
  readonly id: string;
  resolve(
    messages: readonly Message[],
    ctx: MessageResolveContext,
  ): Promise<readonly Message[]>;
}

export type LlmEvent =
  | Exclude<LlmRequestEvent, { type: 'llm.sent' }>
  | { type: 'llm.sent'; recovery?: LlmRecoveryRecord }
  | {
      type: 'llm.retrying';
      failedAttempt: number;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      errorName: string;
      errorMessage: string;
      statusCode?: number;
    }
  | {
      type: 'llm.recovering';
      strategy: string;
      action: string;
      errorName: string;
      errorMessage: string;
      statusCode?: number;
    };

export type LlmOutput = { type: 'succeeded' } | { type: 'failed'; error: LlmErrorMessage };

export interface LlmMachineContext {
  input: LlmInput;
  appliedRecoveries: LlmRecoveryRecord[];
  outcome?: 'succeeded' | 'failed';
  error?: LlmErrorMessage;
  attempt: number;
  delayMs: number;
}

function llmRetryingEvent(
  retry: LlmRetryOptions | undefined,
  context: LlmMachineContext,
  error: LlmErrorMessage,
): Extract<LlmEvent, { type: 'llm.retrying' }> {
  return {
    type: 'llm.retrying',
    failedAttempt: context.attempt,
    nextAttempt: context.attempt + 1,
    maxAttempts: resolveMaxAttempts(retry),
    delayMs: context.delayMs,
    ...retryErrorFields(error),
  };
}

function llmRecoveringEvent(
  context: LlmMachineContext,
  error: LlmErrorMessage,
): Extract<LlmEvent, { type: 'llm.recovering' }> {
  const record = context.appliedRecoveries.at(-1) as LlmRecoveryRecord;
  return {
    type: 'llm.recovering',
    strategy: record.strategy,
    action: record.action,
    ...retryErrorFields(error),
  };
}

function proposeRecovery(
  recovery: LlmRecovery | undefined,
  ctx: LlmRecoveryContext,
): (LlmRecoveryProposal & LlmRecoveryRecord) | undefined {
  if (recovery === undefined) return undefined;
  const proposal = recovery.propose(ctx);
  if (proposal === undefined || proposal.messages === ctx.messages) return undefined;
  return { strategy: recovery.id, action: proposal.action, messages: proposal.messages };
}

function createRequestActor(
  requester: LlmRequester,
  messageResolvers: readonly MessageResolver[],
) {
  return fromCallback<LlmEvent, LlmInput>(({ input, sendBack }) => {
    const controller = new AbortController();
    void (async () => {
      let messages = input.content.messages;
      for (const resolver of messageResolvers) {
        messages = await resolver.resolve(messages, {
          model: input.config.model,
          signal: controller.signal,
        });
      }
      await requester.generate(
        input.config,
        { ...input.content, messages },
        { signal: controller.signal, onEvent: sendBack },
      );
    })();
    return () => controller.abort();
  });
}

export interface CreateLlmMachineOptions {
  requester: LlmRequester;
  messageResolvers?: readonly MessageResolver[];
  recovery?: LlmRecovery;
  retry?: LlmRetryOptions;
}

export function createLlmMachine(options: CreateLlmMachineOptions) {
  const retry = options.retry;
  const recovery = options.recovery;
  const requestActor = createRequestActor(
    withEmptyResponseGuard(options.requester),
    options.messageResolvers ?? [],
  );
  return setup({
    types: {
      input: {} as LlmInput,
      context: {} as LlmMachineContext,
      events: {} as LlmEvent,
      emitted: {} as LlmEvent,
      output: {} as LlmOutput,
    },
    actors: { requestActor },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      sendToParent: ({ self }, params: LlmEvent) => {
        self._parent?.send(params);
      },
    },
    delays: {
      retryDelay: ({ context }) => context.delayMs,
    },
  }).createMachine({
    id: 'llm',
    initial: 'generating',
    context: ({ input }) => ({ input, appliedRecoveries: [], attempt: 1, delayMs: 0 }),
    states: {
      generating: {
        invoke: {
          src: 'requestActor',
          input: ({ context }) => context.input,
        },
        on: {
          'llm.sent': {
            actions: [
              emit(({ context }) => ({
                type: 'llm.sent' as const,
                recovery: context.appliedRecoveries.at(-1),
              })),
              {
                type: 'sendToParent',
                params: ({ context }) => ({
                  type: 'llm.sent' as const,
                  recovery: context.appliedRecoveries.at(-1),
                }),
              },
            ],
          },
          'llm.headers': {
            actions: [
              emit(({ event }) => ({ type: 'llm.headers' as const, headers: event.headers })),
              'forwardToParent',
            ],
          },
          'llm.delta': {
            actions: [
              emit(({ event }) => ({ type: 'llm.delta' as const, part: event.part })),
              'forwardToParent',
            ],
          },
          'llm.usage': {
            actions: [
              emit(({ event }) => ({ type: 'llm.usage' as const, usage: event.usage })),
              'forwardToParent',
            ],
          },
          'llm.finish': {
            actions: [
              emit(({ event }) => ({ type: 'llm.finish' as const, finish: event.finish })),
              'forwardToParent',
            ],
          },
          'llm.message-id': {
            actions: [
              emit(({ event }) => ({ type: 'llm.message-id' as const, messageId: event.messageId })),
              'forwardToParent',
            ],
          },
          'llm.done': {
            target: 'succeeded',
            actions: [
              assign({ outcome: 'succeeded' as const }),
              emit({ type: 'llm.done' as const }),
              'forwardToParent',
            ],
          },
          'llm.failed.syntax': {
            target: 'failed',
            actions: [
              assign({ outcome: 'failed' as const, error: ({ event }) => event.error }),
              emit(({ event }) => ({ type: 'llm.failed.syntax' as const, error: event.error })),
              'forwardToParent',
            ],
          },
          'llm.failed.remote': [
            {
              target: 'generating',
              reenter: true,
              guard: ({ context, event }) =>
                proposeRecovery(recovery, {
                  error: event.error,
                  messages: context.input.content.messages,
                  applied: context.appliedRecoveries,
                }) !== undefined,
              actions: [
                assign(({ context, event }) => {
                  const proposal = proposeRecovery(recovery, {
                    error: event.error,
                    messages: context.input.content.messages,
                    applied: context.appliedRecoveries,
                  });
                  if (proposal === undefined) return {};
                  return {
                    input: {
                      ...context.input,
                      content: { ...context.input.content, messages: proposal.messages },
                    },
                    appliedRecoveries: [
                      ...context.appliedRecoveries,
                      { strategy: proposal.strategy, action: proposal.action },
                    ],
                    attempt: 1,
                  };
                }),
                emit(({ context, event }) => llmRecoveringEvent(context, event.error)),
                {
                  type: 'sendToParent',
                  params: ({ context, event }) => llmRecoveringEvent(context, event.error),
                },
              ],
            },
            {
              target: 'retrying',
              guard: ({ context, event }) =>
                shouldRetry(retry, context.attempt, event.error),
              actions: [
                assign({
                  delayMs: ({ context, event }) =>
                    readRetryAfterMs(event.error) ?? retryBackoffDelay(context.attempt - 1),
                }),
                emit(({ context, event }) => llmRetryingEvent(retry, context, event.error)),
                {
                  type: 'sendToParent',
                  params: ({ context, event }) => llmRetryingEvent(retry, context, event.error),
                },
              ],
            },
            {
              target: 'failed',
              actions: [
                assign({ outcome: 'failed' as const, error: ({ event }) => event.error }),
                emit(({ event }) => ({ type: 'llm.failed.remote' as const, error: event.error })),
                'forwardToParent',
              ],
            },
          ],
        },
      },
      retrying: {
        entry: assign({ attempt: ({ context }) => context.attempt + 1 }),
        after: {
          retryDelay: 'generating',
        },
      },
      succeeded: { type: 'final' },
      failed: { type: 'final' },
    },
    output: ({ context }): LlmOutput =>
      context.outcome === 'failed'
        ? { type: 'failed', error: context.error as LlmErrorMessage }
        : { type: 'succeeded' },
  });
}
