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
 * @throws {APIEmptyResponseError} when the response contains no content and
 *   no tool calls, or only thinking content without any text or tool calls.
 */
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

  options?.onRequestStart?.();
  // Provider streams expose no cancellation handle of their own, so the idle
  // watchdog must tear down a stalled transport through the request's
  // AbortSignal: merge the caller's signal with a watchdog-owned controller
  // and hand the merged signal to the provider.
  const watchdog = new AbortController();
  const providerOptions: GenerateOptions = {
    ...options,
    signal:
      options?.signal === undefined
        ? watchdog.signal
        : AbortSignal.any([options.signal, watchdog.signal]),
  };
  const stream = await provider.generate(systemPrompt, wireTools, history, providerOptions);
  // Early capture: the trace id arrives with the response headers, before the
  // stream body — and before any mid-stream abort — so hosts can attribute
  // even a cancelled stream to its server-side request.
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  // Post-await abort check: `provider.generate()` may have resolved before
  // noticing a mid-flight abort. Reject immediately rather than draining
  // the stream.
  await throwIfAborted(options?.signal, stream);

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

  for await (const part of withStreamIdleTimeout(stream, provider, watchdog)) {
    const arrivedAt = Date.now();
    if (firstPartAt === undefined) {
      firstPartAt = arrivedAt;
    } else {
      serverDecodeMs += arrivedAt - lastResumeAt;
    }

    try {
      await throwIfAborted(options?.signal, stream);

      // Notify raw part callback (deep copy to avoid aliasing mutations).
      if (callbacks?.onMessagePart !== undefined) {
        await callbacks.onMessagePart(deepCopyPart(part));
        await throwIfAborted(options?.signal, stream);
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
    } finally {
      lastResumeAt = Date.now();
      clientConsumeMs += lastResumeAt - arrivedAt;
    }
  }

  await throwIfAborted(options?.signal, stream);
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

/**
 * Guard the gap between streamed chunks with an inactivity deadline.
 *
 * The provider SSE stream has no read timeout of its own — the openai-node
 * HTTP client's request timeout is cleared as soon as response headers arrive
 * (see `openai/src/client.ts` `fetchWithTimeout`, wrapping the fetch call in
 * `try { … } finally { clearTimeout(timeout) }` and resolving on headers) —
 * so a connection that goes silent mid-stream would otherwise block
 * `for await` forever and leave the whole turn hanging. Node's built-in
 * `undici` has a `bodyTimeout`, but it is reset by every SSE heartbeat frame
 * (empty `choices:[]`), so a heartbeat-only channel that stops emitting real
 * deltas never trips it either.
 *
 * If no chunk arrives within the deadline the stream is cancelled and a
 * descriptive `APITimeoutError` subclass is thrown so the step fails loudly
 * and the loop's retry plugin can re-drive it (see
 * `isRetryableGenerateError`).
 */
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env['KIMI_STREAM_IDLE_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
})();

export class StreamIdleTimeoutError extends APITimeoutError {
  readonly idleMs: number;
  readonly elapsedMs: number;
  readonly traceId: string | null;

  constructor(
    providerName: string,
    modelName: string,
    idleMs: number,
    elapsedMs: number,
    traceId: string | null,
  ) {
    const traceHint = traceId === null ? '' : ` traceId=${traceId}`;
    super(
      `LLM stream stalled: no data received for ${Math.round(idleMs / 1000)}s ` +
        `(provider: ${providerName}, model: ${modelName}, ` +
        `elapsedMs: ${elapsedMs}${traceHint}). ` +
        'The connection was abandoned to avoid hanging forever.',
    );
    this.name = 'StreamIdleTimeoutError';
    this.idleMs = idleMs;
    this.elapsedMs = elapsedMs;
    this.traceId = traceId;
  }
}

async function* withStreamIdleTimeout(
  stream: StreamedMessage,
  provider: ChatProvider,
  watchdog: AbortController,
): AsyncGenerator<StreamedMessagePart> {
  const iterator = stream[Symbol.asyncIterator]();
  const startedAt = Date.now();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new StreamIdleTimeoutError(
              provider.name,
              provider.modelName,
              STREAM_IDLE_TIMEOUT_MS,
              Date.now() - startedAt,
              stream.traceId ?? null,
            ),
          );
        }, STREAM_IDLE_TIMEOUT_MS);
      });
      const next = iterator.next();
      let result: IteratorResult<StreamedMessagePart>;
      try {
        result = await Promise.race([next, timeout]);
      } catch (error) {
        if (error instanceof StreamIdleTimeoutError) {
          // The dangling next() will reject once the transport is aborted
          // below; swallow it so it never surfaces as an unhandled rejection.
          next.catch(() => {});
          // Abort the underlying request so the stalled connection is truly
          // closed instead of leaking until the server gives up on it.
          watchdog.abort(error);
          await cancelStream(stream);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    // Close the provider iterator on every exit path (timeout, consumer
    // throw, early break) so generator cleanup runs. Never await it: on a
    // stalled stream `return()` stays pending until the transport abort
    // settles the dangling read, and awaiting would re-introduce the hang.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

function throwAbortError(): never {
  throw new DOMException('The operation was aborted.', 'AbortError');
}

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

  throwAbortError();
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
