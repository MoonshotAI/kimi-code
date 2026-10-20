import { fromCallback } from 'xstate';

import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmModelSpec } from '#/llm/request';
import type { LlmDimension, LlmRequester } from '#/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#/llm/response';
import { toRequestMessages, type HistoryMessage } from '#/history/message';
import { usedContextTokens } from '#/history/usage';
import type { LoopProfile } from '../contract/command';
import { isLlmOutcome } from '../guards';

export type LoopLlmRequester = LlmRequester<LlmDimension>;

export interface RequestActorInput {
  readonly profile: LoopProfile;
  readonly messages: readonly HistoryMessage[];
  readonly signal: AbortSignal;
}

export type RequestActorEvent = LlmRunEvent | { readonly type: 'llm.prepared'; readonly model?: LlmModelSpec };

function failedOutcome(error: unknown): LlmOutcome {
  return { type: 'failed', error: toLlmErrorMessage(error), rawError: error };
}

function isAborted(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted) return true;
  try {
    return isAbortError(error);
  } catch {
    return false;
  }
}

export function createRequestActor(getRequester: () => LoopLlmRequester) {
  return fromCallback<RequestActorEvent, RequestActorInput>(({ input, sendBack }) => {
    let ended = false;
    const end = (outcome: unknown) => {
      if (ended) return;
      ended = true;
      sendBack({
        type: 'llm.ended',
        outcome: isLlmOutcome(outcome) ? outcome : failedOutcome(new Error('invalid llm outcome')),
      });
    };
    const forward = (event: LlmRunEvent) => {
      if (ended) return;
      if (event.type === 'llm.ended') end(event.outcome);
      else sendBack(event);
    };
    void (async () => {
      try {
        const requester = getRequester();
        const messages = toRequestMessages(input.messages);
        const { model, profile } = requester.request({ content: { messages }, profile: input.profile });
        sendBack({ type: 'llm.prepared', model: model?.spec });
        const usedTokens = usedContextTokens(input.messages, profile);
        end(
          await requester.generate(
            { content: { messages, usedTokens }, profile: input.profile },
            { signal: input.signal, onEvent: forward },
          ),
        );
      } catch (error) {
        end(
          isAborted(input.signal, error)
            ? { type: 'aborted', message: null, usage: undefined, reason: input.signal.reason }
            : failedOutcome(error),
        );
      }
    })();
  });
}
