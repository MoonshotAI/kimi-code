import { ApiError as RawGoogleGenAISDKApiError } from '@google/genai';

import { toLlmStatusErrorMessage } from '#/llm/protocol/rules/status';
import type { LlmRemoteErrorMessage } from '#/llm/response';
import { NO_FINISH, type FinishInfo, type FinishReason } from '#/llm/response';
import type { StreamedMessagePart, ThinkPart, ToolCall } from '#/llm/message';
import type { DecodeSink, Decoder } from '#/llm/protocol/protocol';
import type { TokenUsage } from '#/llm/response';

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
      if (p['thought'] === true && typeof p['text'] === 'string') {
        const thoughtSignature = p['thoughtSignature'] ?? p['thought_signature'];
        const thinkPart: ThinkPart = { type: 'think', think: p['text'] };
        if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0) {
          thinkPart.encrypted = thoughtSignature;
        }
        parts.push(thinkPart);
      } else if (p['text']) {
        parts.push({ type: 'text', text: p['text'] as string });
      } else if (p['functionCall'] || p['function_call']) {
        const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
        const name = fc['name'] as string;
        if (!name) continue;
        const id_ = (fc['id'] as string) ?? crypto.randomUUID();
        const toolCallId = `${name}_${id_}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
        const thoughtSigB64 = p['thoughtSignature'] ?? p['thought_signature'];
        const toolCall: ToolCall = {
          type: 'function',
          id: toolCallId,
          name,
          arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
        };
        if (typeof thoughtSigB64 === 'string' && thoughtSigB64.length > 0) {
          toolCall.extras = { thought_signature_b64: thoughtSigB64 };
        }
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

function parseUsage(response: Record<string, unknown>): TokenUsage | undefined {
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
      : 0;
  const candidatesTokenCount =
    typeof usageMetadata['candidatesTokenCount'] === 'number'
      ? usageMetadata['candidatesTokenCount']
      : 0;
  return {
    inputOther: Math.max(promptTokenCount - cachedContentTokenCount, 0),
    output: candidatesTokenCount,
    inputCacheRead: cachedContentTokenCount,
    inputCacheCreation: 0,
    raw: usageMetadata,
  };
}

const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

export function decodeError(error: unknown): LlmRemoteErrorMessage {
  if (error instanceof RawGoogleGenAISDKApiError) {
    return toLlmStatusErrorMessage({
      statusCode: error.status,
      message: error.message,
      retryAfterMs: parseRetryInfoDelayMs(error.message),
    });
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (TIMEOUT_RE.test(msg)) {
      return { kind: 'timeout', message: msg };
    }
    if (NETWORK_RE.test(msg) || (error instanceof TypeError && msg.includes('fetch'))) {
      return { kind: 'connection', message: msg };
    }
    const statusCode = (error as { code?: number }).code;
    if (typeof statusCode === 'number') {
      return toLlmStatusErrorMessage({ statusCode, message: msg });
    }
    return { kind: 'provider', message: `GoogleGenAI error: ${msg}` };
  }
  return { kind: 'unknown', message: `GoogleGenAI error: ${String(error)}` };
}

function parseRetryInfoDelayMs(message: string): number | null {
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const body: unknown = JSON.parse(message.slice(jsonStart));
    if (typeof body !== 'object' || body === null) return null;
    const details = (body as { error?: { details?: unknown } }).error?.details;
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
  } catch {
    return null;
  }
}
