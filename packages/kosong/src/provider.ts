import type { Message, StreamedMessagePart, VideoURLPart } from './message';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/**
 * Thinking effort passed to {@link ChatProvider.withThinking}.
 *
 * `'off'` and `'on'` are the only reserved values: `'off'` disables thinking,
 * and `'on'` is the on-signal for boolean models (models that do not declare
 * `support_efforts`). Everything else is a model-declared effort (e.g.
 * `"low"`, `"high"`, `"max"`) carried as an open string. The type collapses to
 * `string` at runtime; it exists purely as a semantic marker that a value is
 * expected to be `'off'`, `'on'`, or a model-declared effort.
 *
 * The model's `support_efforts` is the single source of truth for which
 * efforts are valid — providers normalize any unrecognized effort by omitting
 * the effort on the wire rather than rejecting it.
 */
export type ThinkingEffort = 'off' | 'on' | (string & {});

/**
 * Optional context passed to {@link ChatProvider.withMaxCompletionTokens} so a
 * provider can tighten the caller-supplied cap to its own transport
 * constraints.
 */
export interface MaxCompletionTokensOptions {
  /**
   * Tokens already consumed by the current context (API-reported input +
   * output of the latest completed step). Chat-completions providers use it
   * to size the cap to the remaining context window.
   */
  readonly usedContextTokens?: number;
  /** Model context-window size in tokens (`max_context_size`). */
  readonly maxContextTokens?: number;
}

/**
 * Normalized finish-reason signal indicating why a generation stopped.
 *
 * Each provider's native stop value is mapped to one of these, and the
 * unmapped original string is preserved in `rawFinishReason` as an escape
 * hatch. `null` means the provider did not emit a finish_reason (e.g. the
 * stream was cut off before the final event).
 *
 * - `'completed'`: normal completion (OpenAI `'stop'`, Anthropic
 *   `'end_turn'` / `'stop_sequence'`, Gemini `'STOP'`).
 * - `'tool_calls'`: generation paused so the caller can dispatch tool
 *   calls and feed their results back. Note that the OpenAI Responses API
 *   and Google GenAI report `'completed'` here; only the Chat
 *   Completions–style providers and Anthropic surface a dedicated value.
 * - `'truncated'`: token budget exhausted (OpenAI `'length'`, Anthropic
 *   `'max_tokens'`, Gemini `'MAX_TOKENS'`, Responses `'max_output_tokens'`).
 * - `'filtered'`: content filter or safety policy blocked the response.
 * - `'paused'`: Anthropic-specific `'pause_turn'`.
 * - `'other'`: recognized non-null reason that does not fit the categories
 *   above.
 */
export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

/**
 * An async-iterable stream of message parts produced by a single LLM response.
 *
 * Consumers iterate over the stream with `for await..of` to receive
 * {@link StreamedMessagePart} chunks. After the iteration completes, the
 * {@link id}, {@link usage}, {@link finishReason}, and
 * {@link rawFinishReason} properties reflect the final values reported by
 * the provider.
 */
export interface StreamedMessage {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
  /** Provider-assigned response identifier, or `null` if not available. */
  readonly id: string | null;
  /** Token usage statistics, populated after the stream completes. */
  readonly usage: TokenUsage | null;
  /**
   * Normalized finish reason, populated after the stream completes.
   *
   * `null` if the provider did not emit a finish_reason (for example, the
   * stream was interrupted before the final event arrived).
   */
  readonly finishReason: FinishReason | null;
  /**
   * Raw provider-specific finish_reason string, preserved verbatim as an
   * escape hatch for callers that need the original wire value.
   *
   * `null` if the provider did not emit a finish_reason.
   */
  readonly rawFinishReason: string | null;
}

/**
 * Options that can be forwarded to a single {@link ChatProvider.generate} call.
 */
export interface ProviderRequestAuth {
  /** Bearer/API token resolved for this specific provider request. */
  apiKey?: string;
  /** Request-scoped headers. These override constructor-level default headers. */
  headers?: Record<string, string>;
}

export interface GenerateOptions {
  /**
   * An {@link AbortSignal} that, when aborted, requests cancellation of the
   * in-flight generate call. Providers that accept a signal will forward it
   * to their underlying HTTP client; the generate loop in
   * {@link generate | generate()} also checks the signal between streamed
   * parts.
   */
  signal?: AbortSignal;
  /**
   * Request-scoped provider auth. Hosts should resolve this immediately before
   * each request/retry so providers never retain mutable credential state.
   */
  auth?: ProviderRequestAuth;
  /**
   * Host-side instrumentation hook fired immediately before invoking the
   * provider adapter's generate call.
   */
  onRequestStart?: () => void;
  /**
   * Host-side instrumentation hook fired by the provider adapter immediately
   * before it dispatches the network request to the upstream API. The window
   * between {@link onRequestStart} and this hook is in-process request-building
   * time (message serialization, param assembly) spent by the client; the
   * window between this hook and the first streamed part is network + server
   * time. Splitting time-to-first-token across this boundary lets hosts
   * attribute latency to the client vs. the API server.
   */
  onRequestSent?: () => void;
  /**
   * Host-side instrumentation hook fired after the provider stream is fully
   * drained, before post-processing the assembled response. Receives the
   * {@link StreamDecodeStats} accounting accumulated across the stream when at
   * least one part was streamed, or `undefined` for an empty stream.
   */
  onStreamEnd?: (stats?: StreamDecodeStats) => void;
}

/**
 * Decode-phase accounting for a single streamed generation. Splits the window
 * from the first streamed part to stream end into the time spent waiting on the
 * provider for the next part (server + network) versus the time spent
 * processing each part in-process (deep copy, host callbacks, part merging).
 *
 * Because both buckets are wall-clock measured on the single JS thread, a
 * stop-the-world GC pause that lands while awaiting the next part is counted in
 * {@link serverDecodeMs}; a non-trivial {@link clientConsumeMs} share is the
 * unambiguous signal that the host's per-part processing is throttling decode.
 */
export interface StreamDecodeStats {
  /** Cumulative time spent awaiting the next streamed part (server + network). */
  readonly serverDecodeMs: number;
  /** Cumulative time spent processing streamed parts in-process (client). */
  readonly clientConsumeMs: number;
}

/**
 * In-memory video bytes for providers that require an uploaded file
 * reference instead of an inline data URL.
 */
export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string | undefined;
}

/**
 * Unified interface for an LLM chat provider.
 *
 * Each provider implementation (Kimi, OpenAI, Anthropic, Google GenAI, etc.)
 * converts the common {@link Message} / {@link Tool} types into the
 * provider-specific wire format, streams back a {@link StreamedMessage}, and
 * exposes configuration helpers such as {@link withThinking}.
 */
export interface ChatProvider {
  /** Short identifier for the provider backend (e.g. `"kimi"`, `"anthropic"`). */
  readonly name: string;
  /** Model name passed to the upstream API (e.g. `"moonshot-v1-auto"`). */
  readonly modelName: string;
  /** Current thinking effort, or `null` if thinking is not configured. */
  readonly thinkingEffort: ThinkingEffort | null;
  /**
   * Send a conversation to the LLM and return a streamed response.
   *
   * @param systemPrompt - System-level instruction prepended to the request.
   * @param tools - Tool definitions the model may invoke.
   * @param history - The conversation history (user, assistant, tool messages).
   * @param options - Optional per-call settings such as an {@link AbortSignal}.
   */
  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage>;
  /** Return a shallow copy of this provider with the given thinking effort. */
  withThinking(effort: ThinkingEffort): ChatProvider;
  /**
   * Return a shallow copy of this provider with the per-request completion
   * budget clamped to `maxCompletionTokens`. Optional because not every
   * backend benefits from a client-computed cap.
   *
   * When `options` are provided, implementations may further tighten the cap
   * based on their own transport constraints — e.g. chat-completions
   * endpoints size the cap to the remaining context window
   * (`maxContextTokens - usedContextTokens`) and/or clamp to a fixed ceiling.
   *
   * Implementations MUST NOT mutate or replace internal HTTP clients on the
   * returned clone — the clone is expected to share transport state with the
   * original. See `KimiChatProvider._clone()` for the rationale.
   */
  withMaxCompletionTokens?(
    maxCompletionTokens: number,
    options?: MaxCompletionTokensOptions,
  ): ChatProvider;
  /** Upload a video and return a content part that can be sent to this provider. */
  uploadVideo?(input: string | VideoUploadInput, options?: GenerateOptions): Promise<VideoURLPart>;
}
