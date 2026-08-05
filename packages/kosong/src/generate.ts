import { APIEmptyResponseError, APITimeoutError } from './errors';
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

/** Snapshot of a ToolCall excluding the internal `_streamIndex` routing field. */
type StoredToolCall = Omit<ToolCall, '_streamIndex'>;

/** Five minutes without response headers or the first streamed part is a dead request. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

/** Thirty seconds between streamed parts is a stalled response. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

const MAX_TIMER_DELAY_MS = 0x7fffffff;
const NEVER_ACTIVITY = new Promise<never>(() => {});

export type ScheduleStreamIdleTimeout = (
  callback: () => void,
  timeoutMs: number,
) => () => void;

/** Driver-only controls layered over the provider's per-request options. */
export interface GenerateDriverOptions extends GenerateOptions {
  /** Maximum wait for response headers and the first streamed part. `0` disables it. */
  readonly responseTimeoutMs?: number;
  /** Maximum wait between streamed parts after output begins. `0` disables it. */
  readonly streamIdleTimeoutMs?: number;
  /** Host timer boundary used to schedule the deadline. */
  readonly scheduleStreamIdleTimeout?: ScheduleStreamIdleTimeout;
}

/**
 * The result of a single {@link generate} call.
 *
 * Contains the fully-assembled assistant {@link message}, an optional
 * provider-assigned {@link id}, and token {@link usage} statistics.
 */
export interface GenerateResult {
  /** Provider-assigned response identifier, or `null` if unavailable. */
  readonly id: string | null;
  /** The fully-assembled assistant message with merged content parts and tool calls. */
  readonly message: Message;
  /** Token usage for this generation, or `null` if not reported. */
  readonly usage: TokenUsage | null;
  /**
   * Normalized finish reason reported by the provider, or `null` if no
   * finish_reason was emitted (for example, the stream was interrupted
   * before the final event).
   */
  readonly finishReason: FinishReason | null;
  /**
   * Raw provider-specific finish_reason string preserved verbatim.
   * `null` if the provider did not emit one.
   */
  readonly rawFinishReason: string | null;
  /**
   * Provider trace identifier from the `x-trace-id` response header
   * (Kimi/KFC only), or `null` when the provider does not report one.
   */
  readonly traceId?: string | null;
}

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  /**
   * Fires once per fully-assembled tool call after the stream drains, in the
   * order tool calls appear in the final assistant message.
   *
   * Tool calls are deliberately deferred until after the stream completes:
   * parallel-tool-call streams may interleave argument deltas across calls
   * (e.g. tc0-header → tc1-header → tc0-args → tc1-args), so firing mid-stream
   * would dispatch a tool with half-parsed arguments and trigger toolParseError.
   */
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
}

/**
 * Generate one assistant message by streaming from the given provider.
 *
 * Parts of the message are streamed and merged: consecutive compatible parts
 * (e.g. TextPart + TextPart, ToolCall + ToolCallPart) are merged in-place so
 * the returned message always contains fully-assembled parts.
 *
 * **Tool call completion** is inferred from merge boundaries (a non-merging
 * next part flushes the pending tool call into `message.toolCalls`) and from
 * stream end. Provider adapters translate native "done" signals into this
 * unified form; the generate loop never sees a separate done event.
 *
 * @param provider - The chat provider to generate from.
 * @param systemPrompt - System-level instruction prepended to the request.
 * @param tools - Tool definitions the model may invoke.
 * @param history - The conversation history sent as context.
 * @param callbacks - Optional streaming callbacks.
 * @param options - Optional per-call settings (e.g. an {@link AbortSignal}).
 *
 * @throws {DOMException} with name `"AbortError"` when `options.signal` is
 *   aborted before or during streaming.
 * @throws {APITimeoutError} when no response headers or streamed part arrive
 *   before the configured idle deadline.
 * @throws {APIEmptyResponseError} when the response contains no content and
 *   no tool calls, or only thinking content without any text or tool calls.
 */
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

  // Map from provider streaming index (e.g. OpenAI Chat `index`, Responses
  // `item_id`) to the position inside `message.toolCalls`. Used to route
  // interleaved argument deltas from parallel tool calls to the correct call.
  const toolCallIndexMap = new Map<number | string, number>();

  // Pre-flight abort check: if the caller's signal is already aborted, we
  // must not issue the provider request at all. Providers that do not
  // themselves honor `signal` would otherwise emit a network call that the
  // caller has explicitly cancelled.
  if (options?.signal?.aborted) {
    throwAbortError();
  }

  // Deferred tools are executable client-side but must not appear in the
  // request's top-level `tools[]` (their schemas travel via message-level
  // `tools` declarations; the top-level list stays byte-stable for prompt
  // caching). This is the single strip point for every provider call.
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
  // A provider may resolve after the caller has already aborted or the idle
  // deadline has fired. Cancel that late stream so it cannot keep its socket
  // or response body alive after generate() has exited.
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
  // Early capture: the trace id arrives with the response headers, before the
  // stream body — and before any mid-stream abort — so hosts can attribute
  // even a cancelled stream to its server-side request.
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  // Post-await abort check: `provider.generate()` may have resolved before
  // noticing a mid-flight abort. Reject immediately rather than draining
  // the stream.
  throwIfAborted(options?.signal, () => {
    stopRequest(stream);
  });

  // Decode-phase accounting. We split the window from the first streamed part
  // to stream end into time spent awaiting the next part (server + network) vs.
  // time spent processing each part in-process (deep copy, host callback, part
  // merge). `lastResumeAt` marks the end of the previous part's processing, so
  // the gap until the next part arrives is attributed to the server. The
  // per-part processing is wrapped in try/finally so the accounting stays
  // correct across `continue` and thrown aborts.
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

      // Notify raw part callback (deep copy to avoid aliasing mutations).
      if (callbacks?.onMessagePart !== undefined) {
        await callbacks.onMessagePart(deepCopyPart(part));
        throwIfAborted(options?.signal, stopStream);
      }

      // Index-based routing for parallel tool call argument deltas.
      // When a ToolCallPart arrives with an index referring to a tool call
      // that is NOT the currently-pending one, append it directly to the
      // correct ToolCall in message.toolCalls instead of relying on sequential
      // merging. This prevents argument cross-contamination across parallel calls.
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
        // Unknown index — fall through to the sequential logic as a safety net.
      }

      if (pendingPart === null) {
        pendingPart = part;
      } else if (!mergeInPlace(pendingPart, part)) {
        // Could not merge — flush the pending part and start a new one.
        // For parallel tool calls this happens when a new ToolCall header arrives
        // while a previous ToolCall is still pending; the flush finalizes the
        // previous tool call into `message.toolCalls`.
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
    // Tail wait: from the last processed part to the stream's done signal.
    serverDecodeMs += Date.now() - lastResumeAt;
  }
  options?.onStreamEnd?.(
    firstPartAt === undefined ? undefined : { serverDecodeMs, clientConsumeMs },
  );

  // Flush the last pending part.
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

  // Think-only response (no real text, no tool calls) is treated as incomplete.
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

  // Fire onToolCall for every fully-assembled tool call, in final order.
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

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwAbortError(): never {
  throw createAbortError();
}

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
  throwAbortError();
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
    throwAbortError();
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

/** True when `pending` is a ToolCall whose _streamIndex equals `index`. */
function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): pending is ToolCall {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

/**
 * Append a fully-merged part to the message.
 *
 * - ContentPart -> message.content
 * - ToolCall    -> message.toolCalls (the `_streamIndex` routing key is
 *                  registered in the map and stripped before storage).
 * - ToolCallPart -> ignored (orphaned delta without a matching pending call)
 */
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
  // ToolCallPart: orphaned delta — silently ignore.
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

/**
 * Produce a shallow-ish copy of a StreamedMessagePart.
 *
 * This is intentionally minimal: we only need isolation for the mutable
 * string fields that `mergeInPlace` mutates (text, think, arguments).
 */
function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  return structuredClone(part);
}
