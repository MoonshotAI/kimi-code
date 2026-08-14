/**
 * `kosong/contract` domain — the generation driver.
 *
 * `generate()` is the single place that orchestrates "call
 * `ChatProvider.generate` and normalize the event stream": it merges streamed
 * deltas into a complete assistant `Message`, fires the caller's callbacks,
 * enforces the abort contract (standard abort DOMException, stream cancelled
 * on abort), bounds response-header and between-part idle waits, and rejects
 * empty or thinking-only responses with `APIEmptyResponseError`.
 */

import {
  APIEmptyResponseError,
  APITimeoutError,
  createAbortError,
} from './errors';
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

export const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

const MAX_TIMER_DELAY_MS = 0x7fffffff;
const NEVER_ACTIVITY = new Promise<never>(() => {});

export type ScheduleStreamIdleTimeout = (
  callback: () => void,
  timeoutMs: number,
) => () => void;

export interface GenerateDriverOptions extends GenerateOptions {
  readonly responseTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly scheduleStreamIdleTimeout?: ScheduleStreamIdleTimeout;
}

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
  options?: GenerateDriverOptions,
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

  const responseTimeoutMs = options?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const streamIdleTimeoutMs = options?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const scheduleIdleTimeout =
    options?.scheduleStreamIdleTimeout ?? scheduleStreamIdleTimeout;
  const requestController = new AbortController();
  const requestSignal =
    options?.signal === undefined
      ? requestController.signal
      : AbortSignal.any([options.signal, requestController.signal]);
  let streamCancelled = false;
  const stopRequest = (stream?: StreamedMessage, iterator?: AsyncIterator<StreamedMessagePart>) => {
    if (!requestController.signal.aborted) {
      requestController.abort(createAbortError());
    }
    if (stream === undefined || streamCancelled) return;
    streamCancelled = true;
    cancelStream(stream, iterator);
  };

  options?.onRequestStart?.();
  const streamPromise = provider.generate(
    systemPrompt,
    wireTools,
    history,
    toProviderOptions(options, requestSignal),
  );
  void streamPromise.then(
    (lateStream) => {
      if (requestSignal.aborted) {
        stopRequest(lateStream);
      }
    },
    () => {},
  );
  const stream = await waitForActivity(
    streamPromise,
    {
      timeoutMs: responseTimeoutMs,
      scheduleTimeout: scheduleIdleTimeout,
      signal: options?.signal,
      stop: stopRequest,
      timeoutError: idleTimeoutError(provider, responseTimeoutMs, 'response'),
    },
  );
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  throwIfAborted(options?.signal, () => {
    stopRequest(stream);
  });

  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;
  let receivedPart = false;
  const iterator = stream[Symbol.asyncIterator]();
  const stopStream = () => {
    stopRequest(stream, iterator);
  };

  for (;;) {
    const timeoutMs = receivedPart ? streamIdleTimeoutMs : responseTimeoutMs;
    const next = await waitForActivity(Promise.resolve(iterator.next()), {
      timeoutMs,
      scheduleTimeout: scheduleIdleTimeout,
      signal: options?.signal,
      stop: stopStream,
      timeoutError: idleTimeoutError(
        provider,
        timeoutMs,
        receivedPart ? 'stream' : 'firstPart',
      ),
    });
    if (next.done === true) break;
    receivedPart = true;
    const part = next.value;
    const arrivedAt = Date.now();
    if (firstPartAt === undefined) {
      firstPartAt = arrivedAt;
    } else {
      serverDecodeMs += arrivedAt - lastResumeAt;
    }

    try {
      throwIfAborted(options?.signal, stopStream);

      if (callbacks?.onMessagePart !== undefined) {
        await callbacks.onMessagePart(deepCopyPart(part));
        throwIfAborted(options?.signal, stopStream);
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
    } catch (error) {
      stopStream();
      throw error;
    } finally {
      lastResumeAt = Date.now();
      clientConsumeMs += lastResumeAt - arrivedAt;
    }
  }

  throwIfAborted(options?.signal, stopStream);
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
      throwIfAborted(options?.signal, stopStream);
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

function cancelStream(
  stream?: StreamedMessage,
  iterator?: AsyncIterator<StreamedMessagePart>,
): void {
  if (stream === undefined) return;
  const cancelable = stream as CancelableStream;
  invokeCancellation(() => cancelable.cancel?.());
  if (iterator !== undefined) {
    invokeCancellation(() => iterator.return?.());
  }
  if ((iterator as unknown) !== stream) {
    invokeCancellation(() => cancelable.return?.());
  }
}

function invokeCancellation(cancel: () => unknown): void {
  try {
    void Promise.resolve(cancel()).catch(() => {});
  } catch {}
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  stop: () => void,
): void {
  if (!signal?.aborted) {
    return;
  }

  stop();
  throw createAbortError();
}

interface ActivityWaitOptions {
  readonly timeoutMs: number;
  readonly scheduleTimeout: ScheduleStreamIdleTimeout;
  readonly signal?: AbortSignal;
  readonly stop: () => void;
  readonly timeoutError: APITimeoutError;
}

async function waitForActivity<T>(
  work: Promise<T>,
  options: ActivityWaitOptions,
): Promise<T> {
  if (options.signal?.aborted === true) {
    options.stop();
    throw createAbortError();
  }

  const abortError = createAbortError();
  let clearTimeout = () => {};
  const timeout: Promise<never> =
    options.timeoutMs <= 0
      ? NEVER_ACTIVITY
      : new Promise((_resolve, reject) => {
          clearTimeout = options.scheduleTimeout(() => {
            reject(options.timeoutError);
          }, Math.min(options.timeoutMs, MAX_TIMER_DELAY_MS));
        });

  let removeAbortListener = () => {};
  const aborted: Promise<never> =
    options.signal === undefined
      ? NEVER_ACTIVITY
      : new Promise((_resolve, reject) => {
          const onAbort = () => {
            reject(abortError);
          };
          options.signal?.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
        });

  try {
    return await Promise.race([work, timeout, aborted]);
  } catch (error) {
    if (error === abortError || error === options.timeoutError) {
      options.stop();
    }
    throw error;
  } finally {
    clearTimeout();
    removeAbortListener();
  }
}

function scheduleStreamIdleTimeout(callback: () => void, timeoutMs: number): () => void {
  const handle = setTimeout(callback, timeoutMs);
  return () => {
    clearTimeout(handle);
  };
}

function toProviderOptions(
  options: GenerateDriverOptions | undefined,
  signal: AbortSignal,
): GenerateOptions {
  const {
    responseTimeoutMs: _responseTimeoutMs,
    streamIdleTimeoutMs: _streamIdleTimeoutMs,
    scheduleStreamIdleTimeout: _scheduleStreamIdleTimeout,
    ...providerOptions
  } = options ?? {};
  return { ...providerOptions, signal };
}

function idleTimeoutError(
  provider: ChatProvider,
  timeoutMs: number,
  phase: 'response' | 'firstPart' | 'stream',
): APITimeoutError {
  const activity =
    phase === 'response'
      ? 'response headers'
      : phase === 'firstPart'
        ? 'the first streamed response part'
        : 'the next streamed response part';
  return new APITimeoutError(
    `Timed out after ${String(timeoutMs)}ms waiting for ${activity} from provider "${provider.name}" model "${provider.modelName}".`,
  );
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
