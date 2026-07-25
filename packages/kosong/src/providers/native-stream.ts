/**
 * Native LLM stream provider — uses the Rust SSE streaming pipeline.
 *
 * When the native module is available, this replaces the TypeScript SDK-based
 * streaming implementations (openai, @anthropic-ai/sdk) with a Rust pipeline
 * that handles HTTP + SSE parsing + event decoding entirely off the JS event loop.
 *
 * The initial implementation collects all stream parts and yields them
 * synchronously (the HTTP streaming happens in Rust, but JS sees the parts
 * after the stream completes). A future iteration will add true streaming
 * via ThreadsafeFunction callbacks for real-time token delivery.
 */

import type { StreamedMessagePart, ToolCall } from '#/message';
import type { FinishReason, StreamedMessage } from '#/provider';
import type { TokenUsage } from '#/usage';

// ── Types matching the native module output ──────────────────────────────────

interface NativeStreamPart {
  partType: string;
  text?: string;
  think?: string;
  encrypted?: string;
  id?: string;
  name?: string;
  arguments?: string;
  argumentsPart?: string;
  streamIndex?: number;
}

interface NativeStreamMetadata {
  responseId?: string;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  traceId?: string;
}

interface NativeStreamResult {
  parts: NativeStreamPart[];
  metadata: NativeStreamMetadata;
  error?: string;
}

export interface NativeLlmStreamConfig {
  provider: 'openai-responses' | 'openai-legacy' | 'anthropic';
  url: string;
  apiKey: string;
  model: string;
  requestBody: string;
  timeoutMs?: number;
  extraHeaders?: Array<{ key: string; value: string }>;
}

// ── Native module access ─────────────────────────────────────────────────────

let nativeModule: Record<string, unknown> | null | undefined;

function getNativeModule(): Record<string, unknown> | undefined {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

// ── Part conversion ──────────────────────────────────────────────────────────

function convertNativePart(part: NativeStreamPart): StreamedMessagePart | null {
  switch (part.partType) {
    case 'text':
      return { type: 'text', text: part.text ?? '' };
    case 'think': {
      const thinkPart: StreamedMessagePart = { type: 'think', think: part.think ?? '' };
      if (part.encrypted !== undefined) {
        (thinkPart as { encrypted: string }).encrypted = part.encrypted;
      }
      return thinkPart;
    }
    case 'function': {
      const tc: ToolCall = {
        type: 'function',
        id: part.id ?? '',
        name: part.name ?? '',
        arguments: part.arguments ?? null,
      };
      if (part.streamIndex !== undefined) {
        tc._streamIndex = part.streamIndex;
      }
      return tc;
    }
    case 'tool_call_part': {
      const callPart: StreamedMessagePart = {
        type: 'tool_call_part',
        argumentsPart: part.argumentsPart ?? null,
      };
      if (part.streamIndex !== undefined) {
        (callPart as { index: number }).index = part.streamIndex;
      }
      return callPart;
    }
    default:
      return null;
  }
}

// ── Finish reason normalization ──────────────────────────────────────────────

function normalizeFinishReason(raw: string | undefined): FinishReason | null {
  if (raw === undefined || raw === null) return null;
  switch (raw) {
    case 'completed':
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'completed';
    case 'max_tokens':
    case 'max_output_tokens':
    case 'length':
      return 'truncated';
    case 'tool_use':
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'filtered';
    case 'pause_turn':
      return 'paused';
    default:
      return 'other';
  }
}

// ── NativeStreamedMessage ────────────────────────────────────────────────────

/**
 * Wraps a completed native LLM stream result as a `StreamedMessage`.
 *
 * The Rust side has already completed the HTTP stream and decoded all events.
 * This class yields the pre-collected parts as an async iterator, matching
 * the interface expected by `generate.ts`.
 */
class NativeStreamedMessage implements StreamedMessage {
  private readonly _parts: StreamedMessagePart[];
  private readonly _id: string | null;
  private readonly _usage: TokenUsage | null;
  private readonly _finishReason: FinishReason | null;
  private readonly _rawFinishReason: string | null;
  private readonly _traceId: string | null;

  constructor(result: NativeStreamResult) {
    this._parts = result.parts
      .map(convertNativePart)
      .filter((p): p is StreamedMessagePart => p !== null);
    this._id = result.metadata.responseId ?? null;
    this._finishReason = normalizeFinishReason(result.metadata.finishReason);
    this._rawFinishReason = result.metadata.finishReason ?? null;
    this._traceId = result.metadata.traceId ?? null;
    this._usage = {
      inputOther: result.metadata.inputTokens - result.metadata.cachedTokens,
      output: result.metadata.outputTokens,
      inputCacheRead: result.metadata.cachedTokens,
      inputCacheCreation: 0,
    };
  }

  get id(): string | null { return this._id; }
  get usage(): TokenUsage | null { return this._usage; }
  get finishReason(): FinishReason | null { return this._finishReason; }
  get rawFinishReason(): string | null { return this._rawFinishReason; }
  get traceId(): string | null { return this._traceId; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this._parts) {
      yield part;
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Try to execute an LLM stream via the Rust native module.
 *
 * Returns a `StreamedMessage` if the native module is available and the
 * request succeeds. Returns `undefined` if the native module is unavailable,
 * allowing the caller to fall through to the SDK-based implementation.
 *
 * Throws an Error (with status info) on API errors so the caller's error
 * handling works consistently.
 */
export async function tryNativeLlmStream(
  config: NativeLlmStreamConfig,
): Promise<StreamedMessage | undefined> {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod['nativeLlmStream'];
  if (typeof fn !== 'function') return undefined;

  try {
    const result = await (fn as (config: unknown) => Promise<NativeStreamResult>)({
      provider: config.provider,
      url: config.url,
      apiKey: config.apiKey,
      model: config.model,
      requestBody: config.requestBody,
      timeoutMs: config.timeoutMs ?? null,
      extraHeaders: config.extraHeaders ?? null,
    });

    if (result.error) {
      // API errors (rate limit, auth, etc.) are surfaced to the caller.
      // Connection/TLS errors from Rust are also surfaced — the caller's
      // try/catch around tryNativeLlmStream will catch them and fall back.
      throw new Error(result.error);
    }

    return new NativeStreamedMessage(result);
  } catch (error) {
    if (error instanceof Error) {
      const msg = error.message;
      // Native module structural errors — fall back silently.
      if (msg.includes('not a function') || msg.includes('not an object')) {
        return undefined;
      }
    }
    // All other errors (API errors, connection errors) propagate to the
    // caller, which wraps them in a try/catch and falls back to SDK.
    throw error;
  }
}
