import {
  APIConnectionError as RawAnthropicSDKConnectionError,
  APIConnectionTimeoutError as RawAnthropicSDKConnectionTimeoutError,
  APIError as RawAnthropicSDKAPIError,
} from '@anthropic-ai/sdk';

import { headersToRecord, parseRetryAfterMs } from '#/llm/protocol/kit/http';
import type { DecodeSink, StreamDecoder } from '#/llm/protocol/protocol';
import { toLlmStatusErrorMessage, toLlmTransportErrorMessage } from '#/llm/protocol/rules/status';
import {
  NO_FINISH,
  type FinishInfo,
  type FinishReason,
  type LlmRemoteErrorMessage,
  type TokenUsage,
} from '#/llm/response';

export type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type RawBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

export type RawResponse = {
  id?: string;
  stop_reason?: string | null;
  usage?: RawUsage;
  content?: RawBlock[];
};

export type RawChunk = {
  type: string;
  index?: number;
  content_block?: RawBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  message?: { id?: string; usage?: RawUsage };
  usage?: RawUsage;
};

function normalizeStopReason(raw: string | null | undefined): FinishInfo {
  if (raw === null || raw === undefined) {
    return NO_FINISH;
  }
  const finishReason: FinishReason = (() => {
    switch (raw) {
      case 'end_turn':
      case 'stop_sequence':
        return 'completed';
      case 'max_tokens':
        return 'truncated';
      case 'tool_use':
        return 'tool_calls';
      case 'pause_turn':
        return 'paused';
      case 'refusal':
        return 'filtered';
      default:
        return 'other';
    }
  })();
  return { finishReason, rawFinishReason: raw };
}

function parseUsage(usage: RawUsage | undefined): Partial<TokenUsage> | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const patch: Partial<TokenUsage> = { raw: usage as Record<string, unknown> };
  if (typeof usage.input_tokens === 'number') {
    patch.inputOther = usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    patch.output = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    patch.inputCacheRead = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    patch.inputCacheCreation = usage.cache_creation_input_tokens;
  }
  return patch;
}

function decodeBlock(block: RawBlock, sink: DecodeSink): void {
  switch (block.type) {
    case 'text':
      if (block.text) {
        sink.onDelta({ type: 'text', text: block.text });
      }
      return;
    case 'thinking':
      sink.onDelta({ type: 'think', think: block.thinking ?? '', encrypted: block.signature });
      return;
    case 'redacted_thinking':
      sink.onDelta({ type: 'think', think: '', encrypted: block.data });
      return;
    case 'tool_use':
      sink.onDelta({
        type: 'function',
        id: block.id ?? crypto.randomUUID(),
        name: block.name ?? '',
        arguments: block.input === undefined ? null : JSON.stringify(block.input),
      });
      return;
  }
}

export function decodeResponse(response: RawResponse, sink: DecodeSink): void {
  if (typeof response.id === 'string' && response.id.length > 0) {
    sink.onMessageId?.(response.id);
  }
  const usage = parseUsage(response.usage);
  if (usage !== undefined) {
    sink.onUsage?.(usage);
  }
  for (const block of response.content ?? []) {
    decodeBlock(block, sink);
  }
  if (response.stop_reason !== undefined && response.stop_reason !== null) {
    sink.onFinish(normalizeStopReason(response.stop_reason));
  }
}

export function createStreamDecoder(): StreamDecoder<RawChunk> {
  return (chunk, sink) => {
    if (chunk.type === 'message_start') {
      const messageId = chunk.message?.id;
      if (typeof messageId === 'string' && messageId.length > 0) {
        sink.onMessageId?.(messageId);
      }
      const usage = parseUsage(chunk.message?.usage);
      if (usage !== undefined) {
        const inputUsage = { ...usage };
        delete inputUsage.output;
        sink.onUsage?.(inputUsage);
      }
      return;
    }
    if (chunk.type === 'message_delta') {
      const usage = parseUsage(chunk.usage);
      if (usage !== undefined) {
        sink.onUsage?.(usage);
      }
      const stopReason = chunk.delta?.stop_reason;
      if (stopReason !== undefined && stopReason !== null) {
        sink.onFinish(normalizeStopReason(stopReason));
      }
      return;
    }
    if (chunk.type === 'content_block_start' && chunk.content_block !== undefined) {
      const block = chunk.content_block;
      const index = chunk.index ?? 0;
      if (block.type === 'tool_use') {
        sink.onDelta({
          type: 'function',
          id: block.id ?? crypto.randomUUID(),
          name: block.name ?? '',
          arguments: '',
          _streamIndex: index,
        });
        return;
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        sink.onDelta({ type: 'think', think: block.thinking });
        return;
      }
      if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
        sink.onDelta({ type: 'think', think: '', encrypted: block.data });
        return;
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        sink.onDelta({ type: 'text', text: block.text });
      }
      return;
    }
    if (chunk.type === 'content_block_delta' && chunk.delta !== undefined) {
      const delta = chunk.delta;
      const index = chunk.index ?? 0;
      if (delta.type === 'text_delta' && delta.text) {
        sink.onDelta({ type: 'text', text: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && delta.thinking) {
        sink.onDelta({ type: 'think', think: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        sink.onDelta({ type: 'tool_call_part', argumentsPart: delta.partial_json, index });
        return;
      }
      if (delta.type === 'signature_delta' && delta.signature) {
        sink.onDelta({ type: 'think', think: '', encrypted: delta.signature });
      }
      return;
    }
  };
}

export function decodeError(error: unknown): LlmRemoteErrorMessage {
  if (error instanceof RawAnthropicSDKConnectionTimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof RawAnthropicSDKConnectionError) {
    return { kind: 'connection', message: error.message };
  }
  if (error instanceof RawAnthropicSDKAPIError && typeof error.status === 'number') {
    return toLlmStatusErrorMessage({
      statusCode: error.status,
      message: error.message,
      requestId: error.requestID ?? null,
      retryAfterMs: parseRetryAfterMs(error.headers),
      headers: headersToRecord(error.headers),
    });
  }
  if (error instanceof Error) {
    return toLlmTransportErrorMessage(error.message);
  }
  return { kind: 'unknown', message: String(error) };
}
