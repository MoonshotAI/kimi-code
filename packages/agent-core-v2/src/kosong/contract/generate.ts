/**
 * `kosong/contract` domain (L0) — the generation driver.
 *
 * `generate()` is the single place that orchestrates "call
 * `ChatProvider.generate` and normalize the event stream": it merges streamed
 * deltas into a complete assistant `Message`, fires the caller's callbacks,
 * enforces the abort contract (standard abort DOMException, stream cancelled
 * on abort), and rejects empty or thinking-only responses with
 * `APIEmptyResponseError`.
 */

import { APIEmptyResponseError, createAbortError } from './errors';
import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from './message';
import type { ChatProvider, FinishReason, GenerateOptions, StreamedMessage } from './provider';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

type StoredToolCall = Omit<ToolCall, '_streamIndex'>;

export interface GenerateResult {
  readonly id: string | null;
  readonly message: Message;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly traceId?: string | null;
}

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
}

export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  const message: Message = { role: 'assistant', content: [], toolCalls: [] };
  let pendingPart: StreamedMessagePart | null = null;

  const toolCallIndexMap = new Map<number | string, number>();

  if (options?.signal?.aborted) {
    throw createAbortError();
  }

  const wireTools = tools.some((tool) => tool.deferred === true)
    ? tools.filter((tool) => tool.deferred !== true)
    : tools;

  options?.onRequestStart?.();
  const stream = await provider.generate(systemPrompt, wireTools, history, options);
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  await throwIfAborted(options?.signal, stream);

  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;

  for await (const part of stream) {
    const arrivedAt = Date.now();
    if (firstPartAt === undefined) {
      firstPartAt = arrivedAt;
    } else {
      serverDecodeMs += arrivedAt - lastResumeAt;
    }

    try {
      await throwIfAborted(options?.signal, stream);

      if (callbacks?.onMessagePart !== undefined) {
        await callbacks.onMessagePart(deepCopyPart(part));
        await throwIfAborted(options?.signal, stream);
      }

      if (
        isToolCallPart(part) &&
        part.index !== undefined &&
        !isPendingToolCallAtIndex(pendingPart, part.index)
      ) {
        const arrayIdx = toolCallIndexMap.get(part.index);
        if (arrayIdx !== undefined) {
          const target = message.toolCalls[arrayIdx];
          if (target !== undefined && part.argumentsPart !== null) {
            target.arguments =
              target.arguments === null
                ? part.argumentsPart
                : target.arguments + part.argumentsPart;
          }
          continue;
        }
      }

      if (pendingPart === null) {
        pendingPart = part;
      } else if (!mergeInPlace(pendingPart, part)) {
        flushPart(message, pendingPart, toolCallIndexMap);
        pendingPart = part;
      }
    } finally {
      lastResumeAt = Date.now();
      clientConsumeMs += lastResumeAt - arrivedAt;
    }
  }

  await throwIfAborted(options?.signal, stream);
  if (firstPartAt !== undefined) {
    serverDecodeMs += Date.now() - lastResumeAt;
  }
  options?.onStreamEnd?.(
    firstPartAt === undefined ? undefined : { serverDecodeMs, clientConsumeMs },
  );

  if (pendingPart !== null) {
    flushPart(message, pendingPart, toolCallIndexMap);
  }
  if (message.content.length === 0 && message.toolCalls.length === 0) {
    throw new APIEmptyResponseError(
      'The API returned an empty response (no content, no tool calls).' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  const hasThink = message.content.some((p) => p.type === 'think');
  const hasText = message.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const hasToolCalls = message.toolCalls.length > 0;

  if (hasThink && !hasText && !hasToolCalls) {
    throw new APIEmptyResponseError(
      'The API returned a response containing only thinking content ' +
        'without any text or tool calls. This usually indicates the ' +
        'stream was interrupted or the output token budget was exhausted ' +
        'during reasoning.' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  if (callbacks?.onToolCall !== undefined) {
    for (const toolCall of message.toolCalls) {
      await throwIfAborted(options?.signal, stream);
      await callbacks.onToolCall(toolCall);
    }
  }

  const result: GenerateResult = {
    id: stream.id,
    message,
    usage: stream.usage,
    finishReason: stream.finishReason,
    rawFinishReason: stream.rawFinishReason,
  };
  if (stream.traceId !== undefined) {
    return { ...result, traceId: stream.traceId };
  }
  return result;
}

type CancelableStream = StreamedMessage & {
  cancel?: () => unknown;
  return?: () => unknown;
};

async function cancelStream(stream: StreamedMessage): Promise<void> {
  const cancelable = stream as CancelableStream;

  try {
    await cancelable.cancel?.();
  } catch {}

  try {
    await cancelable.return?.();
  } catch {}
}

async function throwIfAborted(signal?: AbortSignal, stream?: StreamedMessage): Promise<void> {
  if (!signal?.aborted) {
    return;
  }

  if (stream !== undefined) {
    await cancelStream(stream);
  }

  throw createAbortError();
}

function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): pending is ToolCall {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

function flushPart(
  message: Message,
  part: StreamedMessagePart,
  toolCallIndexMap: Map<number | string, number>,
): void {
  if (isContentPart(part)) {
    message.content.push(part);
    return;
  }
  if (isToolCall(part)) {
    const streamIndex = part._streamIndex;
    const stored: StoredToolCall = {
      type: 'function',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      extras: part.extras,
    };
    const ordinal = message.toolCalls.length;
    message.toolCalls.push(stored as ToolCall);
    if (streamIndex !== undefined) {
      toolCallIndexMap.set(streamIndex, ordinal);
    }
  }
}

function formatFinishReasonHint(stream: StreamedMessage): string {
  if (stream.finishReason === null && stream.rawFinishReason === null) return '';

  const raw =
    stream.rawFinishReason === null ? '' : `, rawFinishReason=${stream.rawFinishReason}`;
  const filteredHint =
    stream.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';

  return ` Provider stop details: finishReason=${stream.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  return structuredClone(part);
}
