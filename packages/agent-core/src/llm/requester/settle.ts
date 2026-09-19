import { emptyResponseError, isAbortError, toLlmErrorMessage, type LlmErrorMessage } from '#/llm/errors';
import {
  createMessageAccumulator,
  salvageInterruptedMessage,
  type AssistantMessage,
  type StreamedMessagePart,
} from '#/llm/message';
import { emptyUsage, mergeUsagePatch, NO_FINISH, type FinishInfo, type TokenUsage } from '#/llm/usage';

import type { LlmRequestConfig, LlmRequestContent, LlmRequestEvent, LlmRequester } from './requester';
import type { ToolCallIdNormalizer } from './tool-call-id';

export interface LlmOutput {
  readonly message: AssistantMessage;
  readonly usage: TokenUsage;
  readonly headers?: Record<string, string>;
  readonly finish?: FinishInfo;
  readonly messageId?: string;
}

export type LlmAborted = Omit<LlmOutput, 'message'> & {
  readonly message: AssistantMessage | null;
};

export type LlmResult =
  | ({ readonly type: 'done' } & LlmOutput)
  | ({
      readonly type: 'failed';
      readonly error: LlmErrorMessage;
      readonly rawError?: unknown;
    } & Partial<LlmOutput>)
  | ({ readonly type: 'aborted' } & LlmAborted);

export type LlmStreamEvent = Exclude<
  LlmRequestEvent,
  { type: 'llm.done' } | { type: 'llm.failed.syntax' } | { type: 'llm.failed.remote' }
>;

export interface SettleLlmRequestInput {
  readonly config: LlmRequestConfig;
  readonly content: LlmRequestContent;
  readonly signal: AbortSignal;
  readonly toolCallIds?: ToolCallIdNormalizer;
}

export async function settleLlmRequest(
  requester: LlmRequester,
  input: SettleLlmRequestInput,
  onEvent?: (event: LlmStreamEvent) => void,
): Promise<LlmResult> {
  const inner = createMessageAccumulator();
  const response = input.toolCallIds?.beginResponse();
  let usage: TokenUsage | undefined;
  let headers: Record<string, string> | undefined;
  let finish: FinishInfo | undefined;
  let messageId: string | undefined;
  let failure: { error: LlmErrorMessage; rawError?: unknown } | undefined;

  const pushPart = (part: StreamedMessagePart): StreamedMessagePart => {
    if (response !== undefined && part.type === 'function') {
      const id = response.remapStreamedId(part.id, part._streamIndex);
      if (id !== part.id) {
        const remapped = { ...part, id, rawId: part.rawId ?? part.id };
        inner.push(remapped);
        return remapped;
      }
    }
    inner.push(part);
    return part;
  };

  const handle = (event: LlmRequestEvent): void => {
    switch (event.type) {
      case 'llm.sent':
        onEvent?.(event);
        return;
      case 'llm.streaming.headers':
        headers = event.headers;
        onEvent?.(event);
        return;
      case 'llm.streaming.part': {
        const part = pushPart(event.part);
        onEvent?.(part === event.part ? event : { ...event, part });
        return;
      }
      case 'llm.streaming.usage':
        usage = mergeUsagePatch(usage, event.usage);
        onEvent?.(event);
        return;
      case 'llm.streaming.finish':
        finish = event.finish;
        onEvent?.(event);
        return;
      case 'llm.streaming.message_id':
        messageId = event.messageId;
        onEvent?.(event);
        return;
      case 'llm.failed.syntax':
        failure = { error: event.error };
        return;
      case 'llm.failed.remote':
        failure = { error: event.error, rawError: event.rawError };
        return;
      case 'llm.done':
        return;
    }
  };

  const extras = () => ({
    usage: usage ?? emptyUsage(),
    headers,
    finish,
    messageId,
  });

  const finishAttempt = (result: LlmResult): LlmResult => {
    if (result.type !== 'done') response?.rollback();
    return result;
  };

  const aborted = (): LlmResult =>
    finishAttempt({
      type: 'aborted',
      message: salvageInterruptedMessage(inner.finish()),
      ...extras(),
    });

  try {
    await requester.generate(input.config, input.content, {
      signal: input.signal,
      onEvent: handle,
    });
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted) {
      return aborted();
    }
    if (failure !== undefined && failure.error.kind !== 'abort') {
      return finishAttempt({ type: 'failed', ...failure, message: inner.finish(), ...extras() });
    }
    return finishAttempt({
      type: 'failed',
      error: toLlmErrorMessage(error),
      rawError: error,
      message: inner.finish(),
      ...extras(),
    });
  }

  if (input.signal.aborted || failure?.error.kind === 'abort') {
    return aborted();
  }
  if (failure !== undefined) {
    return finishAttempt({ type: 'failed', ...failure, message: inner.finish(), ...extras() });
  }

  const message = inner.finish();
  const empty = emptyResponseError(message, input.config.model, finish ?? NO_FINISH);
  if (empty !== null) {
    return finishAttempt({ type: 'failed', error: empty, message, ...extras() });
  }
  return { type: 'done', message, ...extras() };
}
