import { generate, type LlmAttemptEvent } from '#/llm/generate';
import {
  createMessageAccumulator,
  isVacuousContentPart,
  type AssistantMessage,
} from '#/llm/message';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import { createToolCallIdNormalizer } from '#/llm/protocol/rules/tool-call-ids';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import {
  NO_FINISH,
  type FinishInfo,
  type LlmErrorMessage,
  type LlmOutcome,
  type LlmSentEvent,
  type LlmStreamEvent,
  type LlmTiming,
  type TokenUsage,
} from '#/llm/response';
import { clock } from '#/utils/clock';

export function usableOutputOf(message: AssistantMessage): AssistantMessage | null {
  const content = message.content.filter((part) => !isVacuousContentPart(part));
  if (content.every((part) => part.type === 'think')) {
    return null;
  }
  return { role: 'assistant', content, toolCalls: [] };
}

function mergeUsagePatch(base: TokenUsage | undefined, patch: Partial<TokenUsage>): TokenUsage {
  return {
    inputOther: patch.inputOther ?? base?.inputOther ?? 0,
    output: patch.output ?? base?.output ?? 0,
    inputCacheRead: patch.inputCacheRead ?? base?.inputCacheRead ?? 0,
    inputCacheCreation: patch.inputCacheCreation ?? base?.inputCacheCreation ?? 0,
  };
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
  const detail = thinkOnly
    ? 'The API returned a response containing only thinking content without any text or tool calls. This usually indicates the stream was interrupted or the output token budget was exhausted during reasoning.'
    : 'The API returned an empty response (no content, no tool calls).';
  return {
    kind: 'empty_response',
    message: `${detail}${formatFinishReasonHint(finish)} Provider: ${model.provider}, model: ${model.name}`,
    finishReason: finish.finishReason,
    rawFinishReason: finish.rawFinishReason,
  };
}

export function emptyResponseError(
  message: AssistantMessage,
  model: LlmModelSpec,
  finish: FinishInfo,
): LlmErrorMessage<'empty_response'> | null {
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

interface AttemptClock {
  sent(): void;
  partArrived(): number;
  partConsumed(arrivedAt: number): void;
  timing(): LlmTiming | undefined;
}

interface EluSnapshot {
  readonly active: number;
}

function eventLoopUtilization(previous?: EluSnapshot): EluSnapshot | undefined {
  return (
    performance as {
      eventLoopUtilization?: (previous?: EluSnapshot) => EluSnapshot,
    }
  ).eventLoopUtilization?.(previous);
}

function createAttemptClock(): AttemptClock {
  const startedAt = clock();
  let sentAt: number | undefined;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;
  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let eluStart: EluSnapshot | undefined;
  return {
    sent: () => {
      sentAt = clock();
    },
    partArrived: () => {
      const arrivedAt = clock();
      if (firstPartAt === undefined) {
        firstPartAt = arrivedAt;
        eluStart = eventLoopUtilization();
      } else {
        serverDecodeMs += arrivedAt - lastResumeAt;
      }
      return arrivedAt;
    },
    partConsumed: (arrivedAt) => {
      lastResumeAt = clock();
      clientConsumeMs += lastResumeAt - arrivedAt;
    },
    timing: () => {
      if (firstPartAt === undefined) return undefined;
      const endedAt = clock();
      const sent = sentAt === undefined ? undefined : Math.min(Math.max(sentAt, startedAt), firstPartAt);
      const consumed = Math.round(clientConsumeMs);
      const active = eluStart === undefined ? undefined : eventLoopUtilization(eluStart)?.active;
      return {
        firstTokenLatencyMs: Math.round(firstPartAt - startedAt),
        streamDurationMs: Math.round(endedAt - firstPartAt),
        requestBuildMs: sent === undefined ? undefined : Math.round(sent - startedAt),
        serverFirstTokenMs: sent === undefined ? undefined : Math.round(firstPartAt - sent),
        serverDecodeMs: Math.round(serverDecodeMs + (endedAt - lastResumeAt)),
        clientConsumeMs: consumed,
        clientBlockedMs: active === undefined ? undefined : Math.max(0, Math.round(active) - consumed),
      };
    },
  };
}

export interface LlmSettleControl {
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmStreamEvent | LlmSentEvent) => void;
}

export async function settleLlmRequest(
  request: LlmRequest,
  control: LlmSettleControl,
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
  let failure: { error: LlmErrorMessage; rawError?: unknown } | undefined;
  const attemptClock = createAttemptClock();

  const handle = (event: LlmAttemptEvent): void => {
    switch (event.type) {
      case 'llm.notice':
        onEvent?.(event);
        return;
      case 'attempt.sending':
        attemptClock.sent();
        onEvent?.({ type: 'llm.sent' });
        return;
      case 'attempt.tool_call_end': {
        const toolCall = inner.toolCallEnd(event.index);
        if (toolCall !== undefined) {
          onEvent?.({ type: 'llm.streaming.tool_call_end', index: event.index, toolCall });
        }
        return;
      }
      case 'llm.streaming.headers':
        headers = event.headers;
        requestId = request.protocol.base.requestId?.(event.headers);
        onEvent?.(event);
        return;
      case 'llm.streaming.part': {
        const arrivedAt = attemptClock.partArrived();
        const part = toolCallIds.normalizePart(event.part);
        inner.push(part);
        onEvent?.({ type: 'llm.streaming.part', part });
        attemptClock.partConsumed(arrivedAt);
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
      case 'attempt.failed':
        failure = { error: event.error, rawError: event.rawError };
        return;
    }
  };

  const extras = () => ({
    usage,
    headers,
    finish,
    messageId,
    requestId,
    timing: attemptClock.timing(),
  });

  const failed = (
    failure: { error: LlmErrorMessage; rawError?: unknown },
    message: AssistantMessage,
  ): LlmOutcome => ({
    type: 'failed',
    ...failure,
    message,
    ...extras(),
    diagnostics: request.protocol.base.diagnoseError?.({
      error: failure.error,
      rawError: failure.rawError,
      headers,
    }),
  });

  const aborted = (): LlmOutcome => ({
    type: 'aborted',
    message: usableOutputOf(finishMessage()),
    reason:
      failure?.error.kind === 'abort'
        ? failure.error
        : ({ kind: 'abort', message: 'The operation was aborted.' } satisfies LlmErrorMessage<'abort'>),
    ...extras(),
  });

  try {
    await generate(request, { signal, onEvent: handle });
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
  const empty = emptyResponseError(message, request.model.spec, finish ?? NO_FINISH);
  if (empty !== null) {
    return failed({ error: empty }, message);
  }
  return { type: 'done', message, ...extras() };
}
