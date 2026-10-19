import { fromCallback } from '#/xstate2';

import { applyCredential } from '#/credentials/credentials';
import { isAbortError, toLlmErrorMessage } from '#/llm/errors';
import type { Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';

import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestEvent,
  LlmRequester,
} from './requester';
import type { LlmRecoveryRecord } from './recovery';
import { resolveLlmStreamIdleTimeoutMs } from './timeout';

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

const IDLE_WATCHDOG_TERMINAL_EVENTS: ReadonlySet<LlmRequestEvent['type']> = new Set([
  'llm.done',
  'llm.failed.syntax',
  'llm.failed.remote',
]);

function watchStreamIdle(
  idleTimeoutMs: number,
  input: LlmInput,
  sendBack: (event: LlmEvent) => void,
): {
  signal: AbortSignal;
  onEvent: (event: LlmRequestEvent) => void;
  isTimedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    timer = setTimeout(() => {
      timedOut = true;
      sendBack({
        type: 'llm.failed.remote',
        error: {
          kind: 'timeout',
          message: `LLM request stalled: no stream events for ${idleTimeoutMs}ms; aborted the attempt to retry`,
        },
      });
      controller.abort();
    }, idleTimeoutMs);
    timer.unref?.();
  };
  const relayAbort = () => {
    controller.abort(input.signal.reason);
  };
  if (input.signal.aborted) {
    controller.abort(input.signal.reason);
  } else {
    input.signal.addEventListener('abort', relayAbort, { once: true });
  }
  arm();
  return {
    signal: controller.signal,
    onEvent: (event) => {
      if (timedOut) return;
      if (IDLE_WATCHDOG_TERMINAL_EVENTS.has(event.type)) clear();
      else arm();
      sendBack(event);
    },
    isTimedOut: () => timedOut,
    dispose: () => {
      clear();
      input.signal.removeEventListener('abort', relayAbort);
    },
  };
}

export function createRequestActor(
  requester: LlmRequester,
  messageResolvers: readonly MessageResolver[] = [],
) {
  return fromCallback<LlmEvent, LlmInput>(({ input, sendBack }) => {
    void (async () => {
      let watchdog: ReturnType<typeof watchStreamIdle> | undefined;
      try {
        const idleTimeoutMs = resolveLlmStreamIdleTimeoutMs();
        const credential = input.config.credentialProvider?.resolve();
        const config =
          credential === undefined
            ? input.config
            : credential instanceof Promise
              ? {
                  ...input.config,
                  model: applyCredential(input.config.model, await credential),
                }
              : { ...input.config, model: applyCredential(input.config.model, credential) };
        let messages = input.content.messages;
        for (const resolver of messageResolvers) {
          messages = await resolver.resolve(messages, {
            model: config.model,
            signal: input.signal,
          });
        }
        watchdog =
          idleTimeoutMs === undefined
            ? undefined
            : watchStreamIdle(idleTimeoutMs, input, sendBack);
        await requester.generate(
          config,
          { ...input.content, messages },
          watchdog === undefined
            ? { signal: input.signal, onEvent: sendBack }
            : { signal: watchdog.signal, onEvent: watchdog.onEvent },
        );
      } catch (error) {
        if (watchdog?.isTimedOut() === true) return;
        if (isAbortError(error) || input.signal.aborted) return;
        sendBack({ type: 'llm.failed.remote', error: toLlmErrorMessage(error), rawError: error });
      } finally {
        watchdog?.dispose();
      }
    })();
  });
}
