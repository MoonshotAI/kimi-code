import type { Message, StreamedMessagePart, VideoURLPart } from './message';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/**
 * Normalized thinking effort level used across providers.
 *
 * Values above `high` are provider/model-specific and may be clamped by the
 * adapter when the native API has no matching level. OpenAI maps `max` to its
 * `xhigh` ceiling; Kimi and Gemini cap `xhigh`/`max` at `high`; Anthropic
 * supports `xhigh`/`max` only on selected models and otherwise clamps to
 * `high`.
 */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
   * Host-side instrumentation hook fired after the provider stream is fully
   * drained, before post-processing the assembled response.
   */
  onStreamEnd?: () => void;
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
  /** Current thinking-effort level, or `null` if thinking is not configured. */
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
   * Implementations MUST NOT mutate or replace internal HTTP clients on the
   * returned clone — the clone is expected to share transport state with the
   * original. See `KimiChatProvider._clone()` for the rationale.
   */
  withMaxCompletionTokens?(maxCompletionTokens: number): ChatProvider;
  /** Upload a video and return a content part that can be sent to this provider. */
  uploadVideo?(input: string | VideoUploadInput, options?: GenerateOptions): Promise<VideoURLPart>;
}
