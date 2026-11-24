import { generate, type LlmGenerateEvent, type LlmGenerateFailure } from '#/llm/generate';
import {
  createAssistantMessage,
  createMessageAccumulator,
  isVacuousContentPart,
  scanToolDeclarations,
  type AssistantMessage,
  type ToolCall,
  type ToolDescription,
} from '#/llm/message';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import { parseRetryAfterMs } from '#/llm/protocol/kit/http';
import { withoutUndefinedStatusCode } from '#/llm/protocol/rules/status';
import { createToolCallIdNormalizer } from '#/llm/protocol/rules/tool-call-ids';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import { invalidToolArgumentsError } from '#/llm/tool-arguments';
import {
  llmStatusErrorMessage,
  NO_FINISH,
  type FinishInfo,
  type LlmErrorMessage,
  type LlmOutcome,
  type LlmNoticeEvent,
  type LlmDeltaEvent,
  type LlmTiming,
} from '#/llm/response';
import { emptyUsage, mergeUsagePatch, type TokenUsage } from '#/llm/usage';

export function usableOutputOf(message: AssistantMessage): AssistantMessage | null {
  const drained = message.content.filter((part) => !isVacuousContentPart(part));
  const lastCompleteThink = drained.findLastIndex(
    (part) => part.type === 'think' && part.encrypted !== undefined,
  );
  const content = drained.filter((part, index) => part.type !== 'think' || index <= lastCompleteThink);
  if (content.every((part) => part.type === 'think')) {
    return null;
  }
  return { role: 'assistant', content, toolCalls: [] };
}

function formatFinishReasonHint(finish: FinishInfo): string {
  if (finish.finishReason === null && finish.rawFinishReason === null) return '';
  const raw =
    finish.rawFinishReason === null ? '' : `, rawFinishReason=${finish.rawFinishReason}`;
  const filteredHint =
    finish.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';
  return ` Provider stop details: finishReason=${finish.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

function createEmptyResponseError(
  model: LlmModelSpec,
  finish: FinishInfo,
  thinkOnly: boolean,
): LlmErrorMessage<'empty_response'> {
  const detail = finish.rawFinishReason === 'repeat'
    ? 'The API stopped the response because it detected repeated output.'
    : thinkOnly
      ? 'The API returned a response containing only thinking content without any text or tool calls. This usually indicates the stream was interrupted or the output token budget was exhausted during reasoning.'
      : 'The API returned an empty response (no content, no tool calls).';
  return {
    kind: 'empty_response',
    message: `${detail}${formatFinishReasonHint(finish)} Provider: ${model.provider}, model: ${model.name}`,
    finishReason: finish.finishReason,
    rawFinishReason: finish.rawFinishReason,
    retryable: finish.finishReason !== 'filtered',
  };
}

export function emptyResponseError(
  message: AssistantMessage,
  model: LlmModelSpec,
  finish: FinishInfo,
): LlmErrorMessage<'empty_response'> | null {
  if (finish.rawFinishReason === 'repeat') {
    return createEmptyResponseError(model, finish, false);
  }
  const hasToolCalls = message.toolCalls.length > 0;
  if (message.content.length === 0 && !hasToolCalls) {
    return createEmptyResponseError(model, finish, false);
  }
  const hasThink = message.content.some((part) => part.type === 'think');
  const hasText = message.content.some(
    (part) => part.type === 'text' && part.text.trim().length > 0,
  );
  if (hasThink && !hasText && !hasToolCalls) {
    return createEmptyResponseError(model, finish, true);
  }
  return null;
}

export interface LlmRequestControl {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmDeltaEvent | LlmNoticeEvent) => void;
}

export async function runAttempt(
  request: LlmRequest,
  control: LlmRequestControl,
): Promise<LlmOutcome> {
  const { signal, onEvent } = control;
  const inner = createMessageAccumulator();
  const toolCallIds = createToolCallIdNormalizer(
    request.content.messages,
    request.protocol.base.toolCallId,
  );
  let completedMessage: AssistantMessage | undefined;
  const finishMessage = (): AssistantMessage => {
    completedMessage ??= toolCallIds.finish(inner.finish());
    return completedMessage;
  };
  let usage: TokenUsage | undefined;
  let headers: Record<string, string> | undefined;
  let finish: FinishInfo | undefined;
  let messageId: string | undefined;
  let requestId: string | undefined;
  let timing: LlmTiming | undefined;
  let failure: { error: LlmErrorMessage; rawError?: unknown } | undefined;
  const toolCallIndexes = new Map<string, number | string>();
  const emittedToolCallIds = new Set<string>();
  let visibleTools: ReadonlyMap<string, ToolDescription> | undefined;
  const visibleToolMap = (): ReadonlyMap<string, ToolDescription> =>
    (visibleTools ??= scanToolDeclarations(
      request.profile?.tools ?? [],
      request.content.messages,
    ).visible);
  const emitToolCallEnd = (toolCall: ToolCall, index = toolCallIndexes.get(toolCall.id) ?? toolCall._streamIndex): void => {
    if (emittedToolCallIds.has(toolCall.id)) return;
    emittedToolCallIds.add(toolCall.id);
    onEvent?.({ type: 'llm.delta.tool_call_end', index, toolCall });
  };

  const captureFailure = (result: LlmGenerateFailure): void => {
    const statusError = llmStatusErrorMessage(result.error);
    const error =
      statusError === null
        ? result.error
        : withoutUndefinedStatusCode({
            ...statusError,
            requestId: statusError.requestId ?? requestId ?? null,
            retryAfterMs: statusError.retryAfterMs ?? parseRetryAfterMs(headers),
            headers:
              statusError.headers === null
                ? (headers ?? null)
                : { ...headers, ...statusError.headers },
          });
    failure = { error, rawError: result.rawError };
  };

  const handle = (event: LlmGenerateEvent): void => {
    switch (event.type) {
      case 'llm.notice':
        onEvent?.(event);
        return;
      case 'llm.delta.request_id':
        requestId = event.requestId;
        onEvent?.(event);
        return;
      case 'llm.delta.timing':
        timing = {
          firstTokenLatencyMs: event.firstTokenLatencyMs,
          streamDurationMs: event.streamDurationMs,
          requestBuildMs: event.requestBuildMs,
          serverFirstTokenMs: event.serverFirstTokenMs,
          serverDecodeMs: event.serverDecodeMs,
          clientConsumeMs: event.clientConsumeMs,
          clientBlockedMs: event.clientBlockedMs,
        };
        onEvent?.(event);
        return;
      case 'llm.delta.response_header':
        headers = event.headers;
        requestId = request.protocol.base.requestId?.(event.headers);
        onEvent?.(event);
        return;
      case 'llm.delta.part': {
        const normalized = toolCallIds.normalizePart(event.part);
        const accumulated = inner.push(normalized);
        const part = normalized.type === 'think' && accumulated.part.type === 'think'
          ? { ...normalized, hidden: accumulated.part.hidden }
          : normalized;
        onEvent?.({ type: 'llm.delta.part', part, block: accumulated.block });
        return;
      }
      case 'llm.delta.usage':
        usage = mergeUsagePatch(usage, event.usage);
        onEvent?.(event);
        return;
      case 'llm.delta.finish':
        finish = event.finish;
        onEvent?.(event);
        return;
      case 'llm.delta.message_id':
        messageId = event.messageId;
        onEvent?.(event);
        return;
    }
  };

  const extras = () => ({
    usage,
    headers,
    finish,
    messageId,
    requestId,
    timing,
  });

  const assistantMessage = (message: AssistantMessage, source: 'llm' | 'salvaged'): AssistantMessage =>
    createAssistantMessage(message.content, message.toolCalls, {
      source,
      model: { provider: request.model.spec.provider, model: request.model.spec.name },
      usage: source === 'llm' ? usage : (usage ?? emptyUsage()),
      headers,
      finish,
      messageId,
    });

  const failed = (
    failure: { error: LlmErrorMessage; rawError?: unknown },
    message: AssistantMessage,
  ): LlmOutcome => {
    const usable = usableOutputOf(message);
    return {
      type: 'failed',
      ...failure,
      message: failure.error.kind === 'invalid_tool_arguments'
        ? undefined
        : usable === null ? undefined : assistantMessage(usable, 'salvaged'),
      ...extras(),
      diagnostics: request.protocol.base.diagnoseError?.({
        error: failure.error,
        rawError: failure.rawError,
        headers,
      }),
    };
  };

  const aborted = (): LlmOutcome => {
    const usable = usableOutputOf(finishMessage());
    return {
      type: 'aborted',
      message: usable === null ? null : assistantMessage(usable, 'salvaged'),
      reason:
        failure?.error.kind === 'abort'
          ? failure.error
          : ({ kind: 'abort', message: 'The operation was aborted.', retryable: false } satisfies LlmErrorMessage<'abort'>),
      ...extras(),
    };
  };

  try {
    const result = await generate(request, {
      signal,
      onEvent: handle,
      onToolCallEnd: (index) => {
        const toolCall = inner.toolCallEnd(index);
        if (toolCall !== undefined) {
          if (index !== undefined) toolCallIndexes.set(toolCall.id, index);
          const error = invalidToolArgumentsError(toolCall, visibleToolMap());
          if (error === null) {
            emitToolCallEnd(toolCall, index);
          }
        }
      },
    });
    if (result !== undefined) captureFailure(result);
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return aborted();
    }
    if (failure !== undefined && failure.error.kind !== 'abort') {
      return failed(failure, finishMessage());
    }
    return failed({ error: toLlmErrorMessage(error), rawError: error }, finishMessage());
  }

  if (signal.aborted || failure?.error.kind === 'abort') {
    return aborted();
  }
  if (failure !== undefined) {
    return failed(failure, finishMessage());
  }

  const message = finishMessage();
  for (const toolCall of message.toolCalls) {
    const error = invalidToolArgumentsError(toolCall, visibleToolMap());
    if (error !== null) return failed({ error }, message);
    emitToolCallEnd(toolCall);
  }
  const empty = emptyResponseError(message, request.model.spec, finish ?? NO_FINISH);
  if (empty !== null) {
    return failed({ error: empty }, message);
  }
  if (request.protocol.stream !== false && finish === undefined) {
    return failed({
      error: {
        kind: 'provider',
        message: `The API stream ended without a finish event. Provider: ${request.model.spec.provider}, model: ${request.model.spec.name}`,
        retryable: true,
      },
    }, message);
  }
  return { type: 'done', message: assistantMessage(message, 'llm'), ...extras() };
}
