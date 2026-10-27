import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmModelSpec, LlmRequestProfile } from '#/llm/request';
import type { LlmDimension, LlmRequester } from '#/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#/llm/response';
import { toRequestMessages, type HistoryMessage } from '#/history/message';
import { usedContextTokens } from '#/history/usage';
import type { LoopProfile } from './contract/profile';
import { isLlmOutcome } from './guards';

export type LoopLlmRequester = LlmRequester<LlmDimension>;

export interface LoopRequestInput {
  readonly profile: LoopProfile;
  readonly messages: readonly HistoryMessage[];
  readonly signal: AbortSignal;
}

export type LoopRequestProgress = Exclude<LlmRunEvent, { type: 'llm.ended' }> | {
  readonly type: 'llm.prepared';
  readonly model?: LlmModelSpec;
};

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

export function runLoopRequest(
  getRequester: () => LoopLlmRequester,
  input: LoopRequestInput,
  onProgress: (event: LoopRequestProgress) => void,
): Promise<LlmOutcome> {
  let resolve: (outcome: LlmOutcome) => void = () => undefined;
  const promise = new Promise<LlmOutcome>((reply) => {
    resolve = reply;
  });
  let ended = false;
  const end = (value: unknown): void => {
    if (ended) return;
    ended = true;
    resolve(isLlmOutcome(value) ? value : failedOutcome(new Error('invalid llm outcome')));
  };
  const forward = (event: LlmRunEvent): void => {
    if (ended) return;
    if (event.type === 'llm.ended') end(event.outcome);
    else onProgress(event);
  };
  void (async () => {
    try {
      const requester = getRequester();
      const messages = toRequestMessages(input.messages);
      const { systemPrompt, tools } = input.profile;
      const requestProfile: LlmRequestProfile = {
        ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
        ...(tools === undefined ? {} : { tools }),
      };
      const { model, profile } = requester.request({ content: { messages }, profile: requestProfile });
      onProgress({ type: 'llm.prepared', model: model?.spec });
      const usedTokens = usedContextTokens(input.messages, profile);
      end(
        await requester.generate(
          { content: { messages, usedTokens }, profile: requestProfile },
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
  return promise;
}
