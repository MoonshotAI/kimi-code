import { fromCallback } from '#/xstate2/index';

import { isAbortError, toLlmErrorMessage } from '#/llm/errors';
import type { LlmRequester } from '#/llm/requester/requester';
import type { LlmEvent, LlmInput } from '#/llm/requester/input';
import { runLlmRequest, type LlmPolicy } from '#/llm/requester/policy';
import type { LlmResult } from '#/llm/requester/settle';
import { emptyUsage } from '#/llm/usage';

function eventOf(result: LlmResult): LlmEvent {
  if (result.type === 'done') {
    return {
      type: 'llm.done',
      message: result.message,
      usage: result.usage,
      headers: result.headers,
      finish: result.finish,
      messageId: result.messageId,
    };
  }
  if (result.type === 'aborted') {
    return {
      type: 'llm.aborted',
      message: result.message,
      usage: result.usage,
      headers: result.headers,
      finish: result.finish,
      messageId: result.messageId,
    };
  }
  if (result.error.kind === 'syntax') {
    return { type: 'llm.failed.syntax', error: result.error };
  }
  return {
    type: 'llm.failed.remote',
    error: result.error,
    rawError: result.rawError,
  };
}

export function createRequestActor(requester: LlmRequester, policy: LlmPolicy = {}) {
  return fromCallback<LlmEvent, LlmInput>(({ input, sendBack }) => {
    void (async () => {
      try {
        const result = await runLlmRequest(
          requester,
          {
            config: input.config,
            content: input.content,
            signal: input.signal,
            toolCallIds: input.toolCallIds,
            credentialProvider: input.credentialProvider,
          },
          policy,
          (event) => {
            sendBack(event);
          },
        );
        sendBack(eventOf(result));
      } catch (error) {
        if (isAbortError(error) || input.signal.aborted) {
          sendBack({ type: 'llm.aborted', message: null, usage: emptyUsage() });
          return;
        }
        sendBack({ type: 'llm.failed.remote', error: toLlmErrorMessage(error), rawError: error });
      }
    })();
  });
}
