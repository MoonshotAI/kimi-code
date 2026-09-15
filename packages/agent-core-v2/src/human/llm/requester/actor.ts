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

export function createRequestActor(
  requester: LlmRequester,
  messageResolvers: readonly MessageResolver[] = [],
) {
  return fromCallback<LlmEvent, LlmInput>(({ input, sendBack }) => {
    void (async () => {
      try {
        const credential = input.config.credentials?.resolve();
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
        await requester.generate(
          config,
          { ...input.content, messages },
          {
            signal: input.signal,
            onEvent: sendBack,
          },
        );
      } catch (error) {
        if (isAbortError(error) || input.signal.aborted) return;
        sendBack({ type: 'llm.failed.remote', error: toLlmErrorMessage(error), rawError: error });
      }
    })();
  });
}
