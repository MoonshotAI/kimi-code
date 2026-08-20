import { APIEmptyResponseError, APITimeoutError, createAbortError } from './errors';
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

export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 300_000;

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
  const stallAbort = new AbortController();
  const requestSignal =
    options?.signal === undefined
      ? stallAbort.signal
      : AbortSignal.any([options.signal, stallAbort.signal]);
  const stallTimeoutMs = options?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS;
  const generatePromise = provider.generate(systemPrompt, wireTools, history, {
    ...options,
    signal: requestSignal,
  });
  const generateOutcome = await raceStallOrAbort(generatePromise, stallTimeoutMs, requestSignal);
  if (generateOutcome === 'aborted' || generateOutcome === 'stalled') {
    if (generateOutcome === 'stalled') {
      stallAbort.abort();
    }
    void generatePromise
      .then((lateStream) => cancelStream(lateStream))
      .catch(() => undefined);
    if (generateOutcome === 'aborted') {
      throw createAbortError();
    }
    throw new APITimeoutError(
      `The API did not respond within ${stallTimeoutMs}ms (no response headers).` +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
    );
  }
  const stream = generateOutcome;
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  await throwIfAborted(options?.signal, stream);

  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;

  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await nextStreamPart(iterator, stream, stallTimeoutMs, requestSignal, stallAbort);
      if (next === 'stalled') {
        throw new APITimeoutError(
          `The API stream stalled: no data received for ${stallTimeoutMs}ms.` +
            formatFinishReasonHint(stream) +
            ` Provider: ${provider.name}, model: ${provider.modelName}`,
        );
      }
      if (next.done === true) {
        break;
      }
      const part = next.value;
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
  } catch (error) {
    void cancelStream(stream);
    teardownIterator(iterator);
    throw error;
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

async function raceStallOrAbort<T>(
  pending: Promise<T>,
  stallTimeoutMs: number,
  signal: AbortSignal,
): Promise<T | 'stalled' | 'aborted'> {
  if (signal.aborted) {
    return 'aborted';
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const watchdog = new Promise<'stalled' | 'aborted'>((resolve) => {
    if (Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0) {
      timer = setTimeout(() => {
        resolve('stalled');
      }, stallTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }
    onAbort = () => {
      resolve('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([pending, watchdog]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function nextStreamPart(
  iterator: AsyncIterator<StreamedMessagePart>,
  stream: StreamedMessage,
  stallTimeoutMs: number,
  signal: AbortSignal,
  stallAbort: AbortController,
): Promise<IteratorResult<StreamedMessagePart> | 'stalled'> {
  let outcome: IteratorResult<StreamedMessagePart> | 'stalled' | 'aborted';
  try {
    outcome = await raceStallOrAbort(iterator.next(), stallTimeoutMs, signal);
  } catch (error) {
    if (signal.aborted) {
      void cancelStream(stream);
      teardownIterator(iterator);
      throw createAbortError();
    }
    throw error;
  }
  if (outcome === 'aborted') {
    void cancelStream(stream);
    teardownIterator(iterator);
    throw createAbortError();
  }
  if (outcome === 'stalled') {
    stallAbort.abort();
    void cancelStream(stream);
    teardownIterator(iterator);
    return 'stalled';
  }
  return outcome;
}

function teardownIterator(iterator: AsyncIterator<StreamedMessagePart>): void {
  void Promise.resolve(iterator.return?.()).catch(() => undefined);
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
