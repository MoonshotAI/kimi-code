import { generate, type LlmAttemptEvent } from '#/llm/generate';
import {
  isVacuousContentPart,
  type AssistantMessage,
  type ContentPart,
  type ContentPartBase,
  type StreamedMessagePart,
  type ThinkPart,
  type ToolCall,
  type ToolCallPart,
} from '#/llm/message';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import {
  NO_FINISH,
  type FinishInfo,
  type LlmErrorMessage,
  type LlmOutcome,
  type LlmStreamEvent,
  type LlmTiming,
  type TokenUsage,
} from '#/llm/response';


function isContentPart(part: StreamedMessagePart): part is ContentPart {
  const t = part.type;
  return (
    t === 'text' || t === 'think' || t === 'image_url' || t === 'audio_url' || t === 'video_url'
  );
}

function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

function isToolCallPart(part: StreamedMessagePart): part is ToolCallPart {
  return part.type === 'tool_call_part';
}

function samePartIdentity(target: ContentPartBase, source: ContentPartBase): boolean {
  if (
    source.contentType !== undefined &&
    target.contentType !== undefined &&
    source.contentType !== target.contentType
  ) {
    return false;
  }
  if (source.meta !== undefined && target.meta !== undefined && source.meta !== target.meta) {
    if (source.meta.kind !== target.meta.kind) return false;
    const sourceKeys = Object.keys(source.meta);
    const targetKeys = Object.keys(target.meta);
    if (sourceKeys.length !== targetKeys.length) return false;
    for (const key of sourceKeys) {
      if (source.meta[key] !== target.meta[key]) return false;
    }
  }
  return true;
}

function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  if (target.type === 'text' && source.type === 'text') {
    if (!samePartIdentity(target, source)) return false;
    target.text += source.text;
    target.contentType ??= source.contentType;
    target.meta ??= source.meta;
    return true;
  }

  if (target.type === 'think' && source.type === 'think') {
    if (target.encrypted !== undefined) {
      return false;
    }
    if (target.detailsIndex !== source.detailsIndex) {
      return false;
    }
    if (target.hidden !== source.hidden) {
      return false;
    }
    if (target.reasoningKey !== source.reasoningKey) {
      return false;
    }
    if (!samePartIdentity(target, source)) return false;
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
    target.contentType ??= source.contentType;
    target.meta ??= source.meta;
    return true;
  }

  if (target.type === 'function' && source.type === 'tool_call_part') {
    if (source.argumentsPart !== null) {
      target.arguments =
        target.arguments === null
          ? source.argumentsPart
          : target.arguments + source.argumentsPart;
    }
    return true;
  }

  return false;
}

function salvageInterruptedMessage(message: AssistantMessage): AssistantMessage | null {
  const content = message.content.filter((part) => !isVacuousContentPart(part));
  if (content.length === 0) {
    return null;
  }
  return { role: 'assistant', content, toolCalls: [] };
}

export interface MessageAccumulator {
  push(part: StreamedMessagePart): void;
  finish(): AssistantMessage;
}

export function createMessageAccumulator(): MessageAccumulator {
  const message: AssistantMessage = { role: 'assistant', content: [], toolCalls: [] };
  const toolCallIndexMap = new Map<number | string, number>();
  let pending: StreamedMessagePart | null = null;
  let deferredThink: ThinkPart | null = null;
  const flush = () => {
    if (pending !== null) {
      if (isContentPart(pending)) {
        message.content.push(pending);
      } else if (isToolCall(pending)) {
        const ordinal = message.toolCalls.length;
        message.toolCalls.push({
          type: 'function',
          id: pending.id,
          name: pending.name,
          arguments: pending.arguments,
          extras: pending.extras,
          rawId: pending.rawId,
        });
        if (pending._streamIndex !== undefined) {
          toolCallIndexMap.set(pending._streamIndex, ordinal);
        }
      }
      pending = null;
    }
    if (deferredThink !== null) {
      message.content.push(deferredThink);
      deferredThink = null;
    }
  };
  return {
    push(part: StreamedMessagePart) {
      if (
        isToolCallPart(part) &&
        part.index !== undefined &&
        !(pending !== null && isToolCall(pending) && pending._streamIndex === part.index)
      ) {
        const arrayIndex = toolCallIndexMap.get(part.index);
        if (arrayIndex !== undefined) {
          const target = message.toolCalls[arrayIndex];
          if (target !== undefined && part.argumentsPart !== null) {
            target.arguments =
              target.arguments === null
                ? part.argumentsPart
                : target.arguments + part.argumentsPart;
          }
          return;
        }
      }
      if (part.type === 'text') {
        deferredThink = null;
      }
      if (pending === null) {
        pending = structuredClone(part);
        return;
      }
      if (pending.type === 'text' && part.type === 'think' && isVacuousContentPart(part)) {
        deferredThink = structuredClone(part);
        return;
      }
      if (!mergeInPlace(pending, part)) {
        flush();
        pending = structuredClone(part);
      }
    },
    finish(): AssistantMessage {
      flush();
      return message;
    },
  };
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

function createAttemptClock(): AttemptClock {
  const startedAt = performance.now();
  let sentAt: number | undefined;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;
  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let eluStart: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  return {
    sent: () => {
      sentAt = performance.now();
    },
    partArrived: () => {
      const now = performance.now();
      if (firstPartAt === undefined) {
        firstPartAt = now;
        eluStart = performance.eventLoopUtilization?.();
      } else {
        serverDecodeMs += now - lastResumeAt;
      }
      return now;
    },
    partConsumed: (arrivedAt) => {
      lastResumeAt = performance.now();
      clientConsumeMs += lastResumeAt - arrivedAt;
    },
    timing: () => {
      if (firstPartAt === undefined) return undefined;
      const endedAt = performance.now();
      const sent = sentAt === undefined ? undefined : Math.min(Math.max(sentAt, startedAt), firstPartAt);
      const consumed = Math.round(clientConsumeMs);
      const active = eluStart === undefined ? undefined : performance.eventLoopUtilization(eluStart).active;
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
  readonly onEvent?: (event: LlmStreamEvent) => void;
}

export async function settleLlmRequest(
  request: LlmRequest,
  control: LlmSettleControl,
): Promise<LlmOutcome> {
  const { signal, onEvent } = control;
  const inner = createMessageAccumulator();
  let usage: TokenUsage | undefined;
  let headers: Record<string, string> | undefined;
  let finish: FinishInfo | undefined;
  let messageId: string | undefined;
  let requestId: string | undefined;
  let failure: { error: LlmErrorMessage; rawError?: unknown } | undefined;
  const clock = createAttemptClock();

  const handle = (event: LlmAttemptEvent): void => {
    switch (event.type) {
      case 'llm.notice':
        onEvent?.(event);
        return;
      case 'attempt.sending':
        clock.sent();
        return;
      case 'llm.streaming.headers':
        headers = event.headers;
        requestId = request.protocol.base.requestId?.(event.headers);
        onEvent?.(event);
        return;
      case 'llm.streaming.part': {
        const arrivedAt = clock.partArrived();
        inner.push(event.part);
        onEvent?.(event);
        clock.partConsumed(arrivedAt);
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
    timing: clock.timing(),
  });

  const aborted = (): LlmOutcome => ({
    type: 'aborted',
    message: salvageInterruptedMessage(inner.finish()),
    ...extras(),
  });

  try {
    await generate(request, { signal, onEvent: handle });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return aborted();
    }
    if (failure !== undefined && failure.error.kind !== 'abort') {
      return { type: 'failed', ...failure, message: inner.finish(), ...extras() };
    }
    return {
      type: 'failed',
      error: toLlmErrorMessage(error),
      rawError: error,
      message: inner.finish(),
      ...extras(),
    };
  }

  if (signal.aborted || failure?.error.kind === 'abort') {
    return aborted();
  }
  if (failure !== undefined) {
    return { type: 'failed', ...failure, message: inner.finish(), ...extras() };
  }

  const message = inner.finish();
  const empty = emptyResponseError(message, request.model.spec, finish ?? NO_FINISH);
  if (empty !== null) {
    return { type: 'failed', error: empty, message, ...extras() };
  }
  return { type: 'done', message, ...extras() };
}
