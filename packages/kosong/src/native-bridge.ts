/**
 * Native (Rust) LLM provider bindings.
 *
 * This module wraps the kosong-native Rust crate and exposes
 * ChatProvider-compatible interfaces for the agent-core-v2 engine.
 * When the native module is available, it replaces the TypeScript
 * provider implementations to reduce JS↔Rust serialization overhead.
 */

import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { TokenUsage } from '#/usage';
import type { Tool } from '#/tool';
import {
  APIConnectionError,
  APITimeoutError,
  APIStatusError,
  APIProviderRateLimitError,
} from '#/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let native: any = undefined;
try {
  native = require('@moonshot-ai/kosong-native');
} catch {
  // Native module not available; fall back to TypeScript provider
}

/**
 * Whether the native LLM provider module is available.
 */
export const nativeAvailable = native !== undefined;

// ---------------------------------------------------------------------------
// Finish reason normalization (mirrors anthropic.ts normalizeAnthropicStopReason)
// ---------------------------------------------------------------------------

function normalizeFinishReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
    case 'stop':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'max_tokens':
    case 'length':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'tool_use':
    case 'tool_calls':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'pause_turn':
      return { finishReason: 'paused', rawFinishReason: raw };
    case 'refusal':
    case 'content_filter':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}

// ---------------------------------------------------------------------------
// Type converters: TS → Native
// ---------------------------------------------------------------------------

function convertContentPart(part: ContentPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { partType: 'text', text: part.text };
    case 'think':
      return {
        partType: 'think',
        think: part.think,
        encrypted: part.encrypted,
      };
    case 'image_url':
      return {
        partType: 'image_url',
        imageUrl: { url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'audio_url':
      return {
        partType: 'audio_url',
        audioUrl: { url: part.audioUrl.url, id: part.audioUrl.id },
      };
    case 'video_url':
      return {
        partType: 'video_url',
        videoUrl: { url: part.videoUrl.url, id: part.videoUrl.id },
      };
  }
}

function convertToolCall(tc: ToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  };
}

export function convertMessages(history: Message[]): unknown[] {
  return history.map((msg) => ({
    role: msg.role,
    content: msg.content.map(convertContentPart),
    toolCalls: msg.toolCalls.map(convertToolCall),
    toolCallId: msg.toolCallId,
  }));
}

export function convertTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ? JSON.stringify(tool.parameters) : undefined,
    deferred: tool.deferred,
  }));
}

// ---------------------------------------------------------------------------
// Type converters: Native → TS
// ---------------------------------------------------------------------------

function convertNativeContentPart(part: {
  partType: string;
  text?: string;
  think?: string;
  encrypted?: string;
  imageUrl?: { url: string; id?: string };
  audioUrl?: { url: string; id?: string };
  videoUrl?: { url: string; id?: string };
  argumentsPart?: string;
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
  streamIndex?: number;
}): StreamedMessagePart {
  switch (part.partType) {
    case 'text':
      return { type: 'text', text: part.text ?? '' };
    case 'think':
      return {
        type: 'think',
        think: part.think ?? '',
        ...(part.encrypted !== undefined ? { encrypted: part.encrypted } : {}),
      };
    case 'image_url':
      return {
        type: 'image_url',
        imageUrl: { url: part.imageUrl?.url ?? '', id: part.imageUrl?.id },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audioUrl: { url: part.audioUrl?.url ?? '', id: part.audioUrl?.id },
      };
    case 'video_url':
      return {
        type: 'video_url',
        videoUrl: { url: part.videoUrl?.url ?? '', id: part.videoUrl?.id },
      };
    case 'function':
      return {
        type: 'function',
        id: part.id ?? '',
        name: part.name ?? '',
        arguments: part.arguments ?? null,
        ...(part.streamIndex !== undefined ? { _streamIndex: part.streamIndex } : {}),
      };
    case 'tool_call_part':
      return {
        type: 'tool_call_part',
        argumentsPart: part.argumentsPart ?? null,
        ...(part.index !== undefined ? { index: part.index } : {}),
      };
    default:
      return { type: 'text', text: '' };
  }
}

// ---------------------------------------------------------------------------
// Native StreamedMessage wrapper
// ---------------------------------------------------------------------------

class NativeStreamedMessage implements StreamedMessage {
  private _id: string | null;
  private _usage: TokenUsage;
  private _finishReason: FinishReason | null;
  private _rawFinishReason: string | null;
  private readonly _parts: StreamedMessagePart[];
  private _traceId: string | null;

  constructor(nativeResult: {
    id?: string;
    content: Array<Record<string, unknown>>;
    usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number };
    finishReason?: string;
    rawFinishReason?: string;
    traceId?: string;
  }) {
    this._id = nativeResult.id ?? null;
    this._usage = {
      inputOther: nativeResult.usage.inputOther ?? 0,
      output: nativeResult.usage.output ?? 0,
      inputCacheRead: nativeResult.usage.inputCacheRead ?? 0,
      inputCacheCreation: nativeResult.usage.inputCacheCreation ?? 0,
    };
    this._traceId = nativeResult.traceId ?? null;

    const normalized = normalizeFinishReason(nativeResult.finishReason ?? null);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;

    this._parts = nativeResult.content.map(
      (p) => convertNativeContentPart(p as Parameters<typeof convertNativeContentPart>[0]),
    );
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  get traceId(): string | null {
    return this._traceId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this._parts) {
      yield part;
    }
  }
}

// ---------------------------------------------------------------------------
// Error conversion: Native → ChatProviderError
// ---------------------------------------------------------------------------

/**
 * Parse a native error message and convert it to the appropriate
 * ChatProviderError subclass for proper retry handling.
 *
 * Native error message patterns:
 *   "Anthropic API error (429): ..."
 *   "OpenAI API error (503): ..."
 *   "HTTP request failed: ..."
 *   "HTTP timeout: ..."
 */
function convertNativeError(error: unknown): Error {
  if (error instanceof Error) {
    const msg = error.message;

    // HTTP/generic connection errors
    if (msg.includes('request failed') || msg.includes('connection') || msg.includes('eof')) {
      return new APIConnectionError(msg);
    }

    // Timeout errors
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return new APITimeoutError(msg);
    }

    // Status code errors: "Anthropic API error (429): ..." or "OpenAI API error (503): ..."
    const statusMatch = msg.match(/api error \((\d+)\)/i);
    if (statusMatch) {
      const statusCode = parseInt(statusMatch[1]!, 10);
      if (statusCode === 429) {
        return new APIProviderRateLimitError(msg);
      }

      // 5xx / 408 / 409 are retryable
      const retryAfterMs = statusCode >= 500 || statusCode === 408 || statusCode === 409 ? 1000 : null;
      return new APIStatusError(statusCode, msg, null, retryAfterMs);
    }

    // Empty response errors
    if (msg.includes('empty response') || msg.includes('no content')) {
      return new APIStatusError(500, msg, null, 1000);
    }
  }

  // Fallback: wrap as-is
  return error instanceof Error ? error : new Error(String(error));
}

// ---------------------------------------------------------------------------
// Provider factories
// ---------------------------------------------------------------------------

function getApiKey(): string {
  return process.env['ANTHROPIC_API_KEY'] ?? '';
}

function getOpenAIApiKey(): string {
  return process.env['OPENAI_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? '';
}

/**
 * Create a native Anthropic provider if the native module is loaded.
 */
export function createNativeAnthropicProvider(
  model: string,
  baseUrl?: string,
): ChatProvider | undefined {
  if (!nativeAvailable) return undefined;

  return {
    name: 'anthropic',
    modelName: model,
    maxCompletionTokens: undefined,
    thinkingEffort: null,
    modelParameters: {},

    withThinking(_effort: ThinkingEffort): ChatProvider {
      // TODO: support thinking effort in native provider
      return this;
    },

    async generate(
      systemPrompt: string,
      tools: Tool[],
      history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> {
      try {
        const result = await native.anthropicChat(
          getApiKey(),
          model,
          convertMessages(history),
          systemPrompt || undefined,
          tools.length > 0 ? convertTools(tools) : undefined,
          undefined,
          baseUrl || undefined,
        );
        return new NativeStreamedMessage(result);
      } catch (error) {
        throw convertNativeError(error);
      }
    },
  } as ChatProvider;
}

/**
 * Create a native OpenAI-compatible provider if the native module is loaded.
 * Supports thinking_effort passthrough and x-trace-id capture.
 */
function createNativeOpenAIProviderBase(
  name: string,
  model: string,
  baseUrl: string | undefined,
  thinkingEffort: ThinkingEffort | null,
  apiKey: string,
): ChatProvider | undefined {
  if (!nativeAvailable) return undefined;

  return {
    name,
    modelName: model,
    maxCompletionTokens: undefined,
    thinkingEffort,
    modelParameters: {},

    withThinking(effort: ThinkingEffort): ChatProvider {
      return createNativeOpenAIProviderBase(name, model, baseUrl, effort, apiKey)!;
    },

    async generate(
      systemPrompt: string,
      tools: Tool[],
      history: Message[],
      options?: GenerateOptions,
    ): Promise<StreamedMessage> {
      try {
        const result = await native.openaiChat(
          apiKey,
          model,
          convertMessages(history),
          systemPrompt || undefined,
          tools.length > 0 ? convertTools(tools) : undefined,
          undefined,
          thinkingEffort && thinkingEffort !== 'off' ? thinkingEffort : undefined,
          baseUrl || undefined,
        );

        // Forward x-trace-id to the host via callback
        if (result.traceId && options?.onTraceId) {
          options.onTraceId(result.traceId);
        }

        return new NativeStreamedMessage(result);
      } catch (error) {
        throw convertNativeError(error);
      }
    },
  } as ChatProvider;
}

export function createNativeOpenAIProvider(
  model: string,
  baseUrl?: string,
): ChatProvider | undefined {
  return createNativeOpenAIProviderBase('openai', model, baseUrl, null, getOpenAIApiKey());
}

export function createNativeKimiProvider(
  model: string,
  baseUrl?: string,
): ChatProvider | undefined {
  return createNativeOpenAIProviderBase('kimi', model, baseUrl, null, getOpenAIApiKey());
}

/**
 * Create a native Google GenAI (Gemini) provider if the native module is loaded.
 */
export function createNativeGoogleGenAIProvider(
  model: string,
  baseUrl?: string,
): ChatProvider | undefined {
  if (!nativeAvailable) return undefined;

  return {
    name: 'google-genai',
    modelName: model,
    maxCompletionTokens: undefined,
    thinkingEffort: null,
    modelParameters: {},

    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },

    async generate(
      systemPrompt: string,
      tools: Tool[],
      history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> {
      try {
        const result = await native.googleGenaiChat(
          getApiKey(),
          model,
          convertMessages(history),
          systemPrompt || undefined,
          tools.length > 0 ? convertTools(tools) : undefined,
          undefined,
          baseUrl || undefined,
        );
        return new NativeStreamedMessage(result);
      } catch (error) {
        throw convertNativeError(error);
      }
    },
  } as ChatProvider;
}