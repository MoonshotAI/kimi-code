import { fromCallback } from '#/xstate2';

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
