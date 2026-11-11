/**
 * Google GenAI decoding: the stream decoder that turns response chunks into streamed parts, usage, and
 * finish info; replay of a non-streaming response; and SDK error classification.
 */
import { ApiError as RawGoogleGenAISDKApiError } from '@google/genai';

import {
  isTransientHttpStatus,
  isUnreachableConnection,
  toLlmStatusErrorMessage,
  toLlmStreamErrorMessage,
} from '#/llm/protocol/rules/status';
import {
  NO_FINISH,
  type FinishInfo,
  type FinishReason,
  type LlmRemoteErrorMessage,
  type TokenUsage,
} from '#/llm/response';
import type { StreamedMessagePart, ToolCall } from '#/llm/message';
import type { DecodeSink, Decoder } from '#/llm/protocol/protocol';

function extractChunkFinishReason(response: Record<string, unknown>): unknown {
  const candidates = response['candidates'] as unknown[] | undefined;
  const first = candidates?.[0] as Record<string, unknown> | undefined;
  return first?.['finishReason'] ?? first?.['finish_reason'];
}

function normalizeFinishReason(raw: unknown): FinishInfo {
  if (raw === null || raw === undefined) {
    return NO_FINISH;
  }
  let rawString: string;
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase();
  } else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
    rawString = String(raw).toUpperCase();
  } else {
    return NO_FINISH;
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return NO_FINISH;
  }
  const finishReason: FinishReason = (() => {
    switch (rawString) {
      case 'STOP':
        return 'completed';
      case 'MAX_TOKENS':
        return 'truncated';
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
      case 'IMAGE_SAFETY':
        return 'filtered';
      default:
        return 'other';
    }
  })();
  return { finishReason, rawFinishReason: rawString };
}

function extractChunkParts(response: Record<string, unknown>): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];

  const candidates = response['candidates'] as unknown[] | undefined;
  for (const candidate of candidates ?? []) {
    const cand = candidate as Record<string, unknown>;
    const content = cand['content'] as Record<string, unknown> | undefined;
    const contentParts = content?.['parts'] as unknown[] | undefined;
    if (!contentParts) continue;

    for (const part of contentParts) {
      const p = part as Record<string, unknown>;
      const thoughtSignature = p['thoughtSignature'] ?? p['thought_signature'];
      const signature = typeof thoughtSignature === 'string' && thoughtSignature.length > 0
        ? { thought_signature_b64: thoughtSignature }
        : undefined;
      if (p['thought'] === true && typeof p['text'] === 'string') {
        parts.push({ type: 'think', think: p['text'], encrypted: signature?.thought_signature_b64 });
      } else if (typeof p['text'] === 'string') {
        parts.push({ type: 'text', text: p['text'], meta: signature });
      } else if (p['functionCall'] || p['function_call']) {
        const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
        const name = fc['name'] as string;
        if (!name) continue;
        const rawId = typeof fc['id'] === 'string' && fc['id'].length > 0 ? fc['id'] : undefined;
        const id_ = rawId ?? crypto.randomUUID();
        const toolCallId = `${name}_${id_}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
        const toolCall: ToolCall = {
          type: 'function',
          id: toolCallId,
          rawId,
          name,
          arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
          extras: signature,
        };
        parts.push(toolCall);
      }
    }
  }

  return parts;
}

export function replay(response: unknown): unknown[] {
  return [response];
}

export function createDecoder(sink: DecodeSink): Decoder {
  const push = (chunk: unknown): void => {
    const response = chunk as Record<string, unknown>;
    if (response === null || typeof response !== 'object') {
      return;
    }
    const rawFinish = extractChunkFinishReason(response);
    const responseId = response['responseId'];
    if (typeof responseId === 'string' && responseId.length > 0) {
      sink.onMessageId(responseId);
    }
    const usage = parseUsage(response);
    if (usage !== undefined && rawFinish !== undefined && rawFinish !== null) {
      sink.onUsage(usage);
    }
    for (const part of extractChunkParts(response)) {
      sink.onDelta(part);
      if (part.type === 'function') {
        sink.onToolCallEnd();
      }
    }
    if (rawFinish !== undefined && rawFinish !== null) {
      sink.onFinish(normalizeFinishReason(rawFinish));
    }
  };
  return { push, end: () => {} };
}

function parseUsage(response: Record<string, unknown>): Partial<TokenUsage> | undefined {
  const usageMetadata = response['usageMetadata'] as Record<string, unknown> | undefined;
  if (usageMetadata === undefined || usageMetadata === null) {
    return undefined;
  }
  const promptTokenCount =
    typeof usageMetadata['promptTokenCount'] === 'number'
      ? usageMetadata['promptTokenCount']
      : 0;
  const cachedContentTokenCount =
    typeof usageMetadata['cachedContentTokenCount'] === 'number'
      ? usageMetadata['cachedContentTokenCount']
      : undefined;
  const candidatesTokenCount =
    typeof usageMetadata['candidatesTokenCount'] === 'number'
      ? usageMetadata['candidatesTokenCount']
      : 0;
  return {
    inputOther: Math.max(promptTokenCount - (cachedContentTokenCount ?? 0), 0),
    output: candidatesTokenCount,
    inputCacheRead: cachedContentTokenCount,
    inputCacheCreation: 0,
    raw: usageMetadata,
  };
}

const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

interface GoogleGenAIErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly status?: unknown;
    readonly details?: unknown;
    readonly requestId?: unknown;
    readonly request_id?: unknown;
  };
}

export function decodeError(error: unknown, source?: 'stream'): LlmRemoteErrorMessage {
  if (error instanceof RawGoogleGenAISDKApiError) {
    const body = parseGoogleGenAIErrorBody(error.message);
    const message = typeof body?.error?.message === 'string' ? body.error.message : '';
    const code = body?.error?.code;
    const status = body?.error?.status;
    const statusCode = source === 'stream' ? undefined : error.status;
    const retryAfterMs = parseRetryInfoDelayMs(body);
    const requestId =
      typeof body?.error?.requestId === 'string'
        ? body.error.requestId
        : typeof body?.error?.request_id === 'string'
          ? body.error.request_id
          : null;
    const headers = requestId === null ? null : { 'x-request-id': requestId };
    if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
      return {
        kind: 'rate_limit',
        message,
        statusCode,
        requestId,
        retryAfterMs,
        headers,
        retryable: true,
      };
    }
    if (code === 529 || status === 'OVERLOADED') {
      return {
        kind: 'overloaded',
        message,
        statusCode,
        requestId,
        retryAfterMs,
        headers,
        retryable: true,
      };
    }
    if (source === 'stream') {
      const businessCode = typeof code === 'number' ? code : error.status;
      return toLlmStreamErrorMessage({
        businessCode,
        message,
        retryable: businessCode === undefined || isTransientHttpStatus(businessCode),
        retryAfterMs,
        requestId,
        headers,
      });
    }
    return toLlmStatusErrorMessage({
      statusCode: error.status,
      message,
      retryable: isTransientHttpStatus(error.status),
      retryAfterMs,
      requestId,
      headers,
    });
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (TIMEOUT_RE.test(msg)) {
      return { kind: 'timeout', message: msg, retryable: true };
    }
    if (NETWORK_RE.test(msg) || (error instanceof TypeError && msg.includes('fetch'))) {
      return { kind: 'connection', message: msg, retryable: !isUnreachableConnection(error) };
    }
    const code = (error as { code?: number }).code;
    if (typeof code === 'number') {
      if (source === 'stream') {
        return toLlmStreamErrorMessage({
          businessCode: code,
          message: msg,
          retryable: isTransientHttpStatus(code),
        });
      }
      return toLlmStatusErrorMessage({
        statusCode: code,
        message: msg,
        retryable: isTransientHttpStatus(code),
      });
    }
    return { kind: 'provider', message: `GoogleGenAI error: ${msg}`, retryable: true };
  }
  return { kind: 'unknown', message: `GoogleGenAI error: ${String(error)}`, retryable: false };
}

function parseGoogleGenAIErrorBody(message: string): GoogleGenAIErrorBody | undefined {
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return undefined;
  try {
    const body: unknown = JSON.parse(message.slice(jsonStart));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    return body as GoogleGenAIErrorBody;
  } catch {
    return undefined;
  }
}

function parseRetryInfoDelayMs(body: GoogleGenAIErrorBody | undefined): number | null {
  const details = body?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null) continue;
    const type = (detail as { '@type'?: unknown })['@type'];
    if (typeof type !== 'string' || !type.endsWith('google.rpc.RetryInfo')) continue;
    const retryDelay = (detail as { retryDelay?: unknown }).retryDelay;
    if (typeof retryDelay !== 'string') continue;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay.trim());
    if (match?.[1] === undefined) continue;
    const seconds = Number.parseFloat(match[1]);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    return Math.round(seconds * 1000);
  }
  return null;
}
