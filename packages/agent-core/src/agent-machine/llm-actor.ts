import { fromCallback } from '#/xstate2/index';

import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmPolicy } from '#/llm/policy/policy';
import type { LlmDimension, LlmRequester, LlmRequestPart } from '#/llm/requester';
import type { LlmRemoteErrorMessage, LlmRunEvent } from '#/llm/response';

export type AgentLlmRequester = LlmRequester<LlmDimension>;

export interface LlmActorInput {
  readonly rest: LlmRequestPart;
  readonly signal: AbortSignal;
}

function failedEvent(error: LlmRemoteErrorMessage, rawError?: unknown): LlmRunEvent {
  return { type: 'llm.ended', outcome: { type: 'failed', error, rawError } };
}

export function createRequestActor(
  getRequester: () => AgentLlmRequester | undefined,
  policy: LlmPolicy = {},
) {
  return fromCallback<LlmRunEvent, LlmActorInput>(({ input, sendBack }) => {
    void (async () => {
      try {
        const requester = getRequester();
        if (requester === undefined) {
          const raw = new Error('requester is not set');
          sendBack(failedEvent(toLlmErrorMessage(raw), raw));
          return;
        }
        await requester.generate(
          { ...input.rest, policy },
          { signal: input.signal, onEvent: (event) => sendBack(event) },
        );
      } catch (error) {
        if (isAbortError(error) || input.signal.aborted) {
          sendBack({
            type: 'llm.ended',
            outcome: { type: 'aborted', message: null, usage: undefined },
          });
          return;
        }
        sendBack(failedEvent(toLlmErrorMessage(error), error));
      }
    })();
  });
}
