import { ApiError as RawGoogleGenAISDKApiError, type GenerateContentParameters } from '@google/genai';

import {
  isAbortError,
  SyntaxRequestFormatError,
  toLlmErrorMessage,
  toLlmStatusErrorMessage,
  type LlmRemoteErrorMessage,
} from '#/llm/errors';
import {
  createMediaLowerer,
  mediaContextOf,
  type MaterializedMedia,
} from '#/llm/media/materialize';
import type {
  Message,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolDescription,
  ToolMessage,
} from '#/llm/message';
import type { ResponseFormat } from '#/llm/model';
import type { FormatRequestInput, ProtocolFormat } from '#/llm/protocol/format';
import { applyPatterns, mergeConsecutiveUsers, type Pattern } from '#/llm/protocol/rewrite';
import type { ThinkingEffort } from '#/llm/thinking';
import { NO_FINISH, type FinishInfo, type FinishReason, type TokenUsage } from '#/llm/usage';

export type NativeMessage = {
  role: 'user' | 'model';
  parts: NativePart[];
};

export type NativePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: {
    name: string;
    response: Record<string, string>;
    parts: NativePart[];
  };
};

export const sortToolRunByCallOrder: Pattern<Message> = {
  name: 'sortToolRunByCallOrder',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role !== 'assistant' || message.toolCalls.length === 0) {
      return null;
    }
    let end = index + 1;
    while (end < items.length && items[end]?.role === 'tool') {
      end += 1;
    }
    if (end === index + 1) return null;
    const run = items.slice(index + 1, end) as ToolMessage[];
    const toolMsgById = new Map<string, ToolMessage>();
    const seenToolCallIds = new Set<string>();
    for (const toolMsg of run) {
      if (seenToolCallIds.has(toolMsg.toolCallId)) {
        throw new SyntaxRequestFormatError(`Duplicate tool response for id: ${toolMsg.toolCallId}`);
      }
      seenToolCallIds.add(toolMsg.toolCallId);
      toolMsgById.set(toolMsg.toolCallId, toolMsg);
    }
    const sorted: ToolMessage[] = [];
    for (const toolCall of message.toolCalls) {
      const msg = toolMsgById.get(toolCall.id);
      if (msg === undefined) {
        throw new SyntaxRequestFormatError(`Missing tool responses for ids: ${toolCall.id}`);
      }
      sorted.push(msg);
      toolMsgById.delete(toolCall.id);
    }
    if (toolMsgById.size > 0) {
      throw new SyntaxRequestFormatError(
        `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
      );
    }
    if (run.every((msg, i) => msg === sorted[i])) return null;
    return { consumed: 1 + run.length, replacement: [message, ...sorted] };
  },
};

function toolCallIdToName(toolCallId: string, toolNameById: Map<string, string>): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  const withoutEntropy = toolCallId.replace(/_[0-9a-f]{8}$/, '');
  const match = /^(.+)_[^_]+$/.exec(withoutEntropy);
  return match?.[1] ?? withoutEntropy;
}

function convertMaterialized(
  materialized: MaterializedMedia,
  fallbackMimeType: string,
): NativePart {
  if (materialized.form === 'omit') return { text: materialized.text };
  if (materialized.form === 'inline') {
    return { inlineData: { mimeType: materialized.mimeType, data: materialized.data } };
  }
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(materialized.url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {}
  return { fileData: { fileUri: materialized.url, mimeType } };
}

export function buildToolNameById(messages: readonly Message[]): Map<string, string> {
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.toolCalls) {
      toolNameById.set(toolCall.id, toolCall.name);
    }
  }
  return toolNameById;
}

export interface LowerContext {
  readonly toolNameById: Map<string, string>;
}

async function lowerMessage(
  message: Message,
  lower: LowerContext,
  materialize: ReturnType<typeof createMediaLowerer>,
): Promise<NativeMessage[]> {
  const { toolNameById } = lower;
  if (message.role === 'tool') {
    let textOutput = '';
    const mediaParts: NativePart[] = [];
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          if (part.text) textOutput += part.text;
          break;
        case 'image_url':
          mediaParts.push(convertMaterialized(await materialize(part), 'image/jpeg'));
          break;
        case 'audio_url':
          mediaParts.push(convertMaterialized(await materialize(part), 'audio/mpeg'));
          break;
        case 'video_url':
          mediaParts.push(convertMaterialized(await materialize(part), 'video/mp4'));
          break;
        case 'think':
          break;
      }
    }
    return [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: toolCallIdToName(message.toolCallId, toolNameById),
              response: { output: textOutput },
              parts: [],
            },
          },
          ...mediaParts,
        ],
      },
    ];
  }

  if (message.role === 'system') {
    const text = message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.length === 0) return [];
    return [
      {
        role: 'user',
        parts: [{ text: `<system>${text}</system>` }],
      },
    ];
  }

  const role = message.role === 'assistant' ? 'model' : 'user';
  const parts: NativePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ text: part.text });
        break;
      case 'think': {
        const thoughtPart: NativePart = { text: part.think, thought: true };
        if (part.encrypted !== undefined && part.encrypted.length > 0) {
          thoughtPart.thoughtSignature = part.encrypted;
        }
        parts.push(thoughtPart);
        break;
      }
      case 'image_url':
        parts.push(convertMaterialized(await materialize(part), 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMaterialized(await materialize(part), 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMaterialized(await materialize(part), 'video/mp4'));
        break;
    }
  }

  if (message.role === 'assistant') {
    for (const toolCall of message.toolCalls) {
      let args: Record<string, unknown> = {};
      if (toolCall.arguments) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(toolCall.arguments);
        } catch {
          throw new SyntaxRequestFormatError('Tool call arguments must be valid JSON.');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new SyntaxRequestFormatError('Tool call arguments must be a JSON object.');
        }
        args = parsed as Record<string, unknown>;
      }

      const functionCallPart: NativePart = {
        functionCall: {
          name: toolCall.name,
          args,
        },
      };

      if (toolCall.extras && 'thought_signature_b64' in toolCall.extras) {
        functionCallPart['thoughtSignature'] = toolCall.extras['thought_signature_b64'] as string;
      }

      parts.push(functionCallPart);
    }
  }

  return [{ role, parts }];
}

export function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      },
    ],
  };
}

export async function lower(input: FormatRequestInput): Promise<NativeMessage[]> {
  const normalized = applyPatterns(input.messages, [sortToolRunByCallOrder]);
  const toolNameById = buildToolNameById(normalized);
  const materialize = createMediaLowerer(mediaContextOf(input));
  const lowered: NativeMessage[] = [];
  for (const message of normalized) {
    lowered.push(...(await lowerMessage(message, { toolNameById }, materialize)));
  }
  return applyPatterns(lowered, [
    mergeConsecutiveUsers({
      isUser: (content) => content.role === 'user',
      isToolResultOnly: (content) => content.parts[0]?.functionResponse !== undefined,
      merge: (last, next) => {
        const lastStartsWithFunctionResponse = last.parts[0]?.functionResponse !== undefined;
        const nextHasFunctionResponse = next.parts.some(
          (part) => part.functionResponse !== undefined,
        );
        if (lastStartsWithFunctionResponse && !nextHasFunctionResponse) {
          return { ...next, parts: [...next.parts, ...last.parts] };
        }
        return { ...last, parts: [...last.parts, ...next.parts] };
      },
    }),
  ]);
}

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

export function encodeThinking(
  model: string,
  effort: ThinkingEffort,
): Record<string, unknown> {
  if (model.includes('gemini-3')) {
    switch (effort) {
      case 'off':
        return { includeThoughts: false, thinkingLevel: 'MINIMAL' };
      case 'low':
        return { includeThoughts: true, thinkingLevel: 'LOW' };
      case 'medium':
        return { includeThoughts: true, thinkingLevel: 'MEDIUM' };
      case 'high':
      case 'xhigh':
      case 'max':
        return { includeThoughts: true, thinkingLevel: 'HIGH' };
      default:
        return { includeThoughts: true };
    }
  }
  switch (effort) {
    case 'off':
      return { includeThoughts: false, thinkingBudget: 0 };
    case 'low':
      return { includeThoughts: true, thinkingBudget: 1024 };
    case 'medium':
      return { includeThoughts: true, thinkingBudget: 4096 };
    case 'high':
    case 'xhigh':
    case 'max':
      return { includeThoughts: true, thinkingBudget: 32_000 };
    default:
      return { includeThoughts: true };
  }
}

export function encodeMaxTokens(cap: number): Record<string, unknown> {
  return { maxOutputTokens: cap };
}

export function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat,
): Record<string, unknown> {
  const { responseSchema: _dropSchema, responseJsonSchema: _dropJsonSchema, ...rest } = kwargs;
  return {
    ...rest,
    responseMimeType: 'application/json',
    responseJsonSchema: format.type === 'json_schema' ? format.jsonSchema.schema : undefined,
  };
}

export interface Request {
  readonly params: GenerateContentParameters;
  readonly headers?: Record<string, string>;
}

export interface AssembleParts {
  readonly messages: readonly NativeMessage[];
  readonly tools: readonly Record<string, unknown>[];
  readonly kwargs: Readonly<Record<string, unknown>>;
}

export function assemble(
  input: FormatRequestInput,
  parts: AssembleParts,
): Record<string, unknown> {
  return {
    model: input.model.model,
    contents: parts.messages,
    config: {
      systemInstruction: input.systemPrompt ? input.systemPrompt : undefined,
      tools: parts.tools.length === 0 ? undefined : parts.tools,
      ...parts.kwargs,
    },
  };
}

export function encode(
  params: Record<string, unknown>,
): Request {
  return { params: params as unknown as GenerateContentParameters };
}

export function createFormat(): ProtocolFormat {
  return {
    createStreamParser() {
      return (chunk, sink) => {
        const response = chunk as Record<string, unknown>;
        if (response === null || typeof response !== 'object') {
          return;
        }
        const rawFinish = extractChunkFinishReason(response);
        const responseId = response['responseId'];
        if (typeof responseId === 'string' && responseId.length > 0) {
          sink.onMessageId?.(responseId);
        }
        const usage = parseUsage(response);
        if (usage !== undefined && rawFinish !== undefined && rawFinish !== null) {
          sink.onUsage?.(usage);
        }
        if (rawFinish !== undefined && rawFinish !== null) {
          sink.onFinish(normalizeFinishReason(rawFinish));
        }
        for (const part of extractChunkParts(response)) {
          sink.onDelta(part);
        }
      };
    },
  };
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

export function convertError(
  error: unknown,
  classifyErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined,
): LlmRemoteErrorMessage {
  if (isAbortError(error)) {
    return toLlmErrorMessage(error);
  }
  const hooked = classifyErrorHook?.(error);
  if (hooked !== undefined) {
    return hooked;
  }
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
