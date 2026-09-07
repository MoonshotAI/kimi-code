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
import type { LlmRecoveryRecord } from './recovery';

export interface LlmInput {
  readonly config: LlmRequestConfig;
  readonly content: LlmRequestContent;
  readonly signal: AbortSignal;
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
  outcome?: 'succeeded' | 'failed';
  error?: LlmErrorMessage;
}

function createRequestActor(
  requester: LlmRequester,
  messageResolvers: readonly MessageResolver[],
) {
  return fromCallback<LlmEvent, LlmInput>(({ input, sendBack }) => {
    void (async () => {
      let messages = input.content.messages;
      for (const resolver of messageResolvers) {
        messages = await resolver.resolve(messages, {
          model: input.config.model,
          signal: input.signal,
        });
      }
      await requester.generate(
        input.config,
        { ...input.content, messages },
        {
          signal: input.signal,
          onEvent: sendBack,
        },
      );
    })();
  });
}

export interface CreateLlmMachineOptions {
  requester: LlmRequester;
  messageResolvers?: readonly MessageResolver[];
}

export function createLlmMachine(options: CreateLlmMachineOptions) {
  const requestActor = createRequestActor(options.requester, options.messageResolvers ?? []);
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
  }).createMachine({
    id: 'llm',
    initial: 'generating',
    context: ({ input }) => ({ input }),
    states: {
      generating: {
        invoke: {
          src: 'requestActor',
          input: ({ context }) => context.input,
        },
        on: {
          'llm.sent': {
            actions: [
              emit({ type: 'llm.sent' as const }),
              { type: 'sendToParent', params: { type: 'llm.sent' as const } },
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
          'llm.failed.remote': {
            target: 'failed',
            actions: [
              assign({ outcome: 'failed' as const, error: ({ event }) => event.error }),
              emit(({ event }) => ({ type: 'llm.failed.remote' as const, error: event.error })),
              'forwardToParent',
            ],
          },
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
