import { anthropicProtocol, CONTEXT_MANAGEMENT_BETA } from '#/llm/builtin/protocol/anthropic/index';
import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';
import {
  OPENAI_REASONING_KEYS,
  openAIProtocol,
  type OpenAINativeMessage,
  type OpenAIOptions,
  type OpenAIRawChunk,
  type OpenAIRawUsage,
} from '#/llm/builtin/protocol/openai/index';
import type { ContentPart, MediaKind, Message, ToolDescription } from '#/llm/message';
import { headersToRecord, parseRetryAfterMs, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { BASELINE_IMAGE_MIMES } from '#/llm/protocol/kit/media';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { MediaKindSupport, MediaSupport } from '#/llm/protocol/rules/media';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { LlmRemoteErrorMessage } from '#/llm/response';

import { decodeReasoningDetails, hasReasoningContent, withReasoningDetails } from './reasoning';
import { normalizeKimiToolSchema } from './schema';

const KIMI_IMAGE_MIMES: ReadonlySet<string> = new Set([
  ...BASELINE_IMAGE_MIMES,
  'image/bmp',
  'image/heic',
  'image/heif',
]);

const KIMI_UPLOADED_VIDEO: MediaKindSupport = { mimes: 'any', sources: ['url'], inToolResult: 'native' };

function kimiMedia(
  base: MediaSupport,
  extra: Partial<Record<MediaKind, MediaKindSupport>> = {},
): MediaSupport {
  const kinds: Partial<Record<MediaKind, MediaKindSupport>> = {};
  for (const [kind, spec] of Object.entries({ ...base.kinds, ...extra }) as [MediaKind, MediaKindSupport][]) {
    kinds[kind] = { ...spec, mimes: kind === 'image' ? KIMI_IMAGE_MIMES : spec.mimes, inToolResult: 'native' };
  }
  return { kinds };
}

const kimiRequestId = requestIdFromHeader('x-trace-id');

function kimiLegality(base: { readonly legality: ModelLegality }): ModelLegality {
  return {
    ...base.legality,
    fillMaxOutputTokens: (spec, usedTokens) => {
      const window = spec.maxContextSize;
      if (window === undefined || window <= 0 || usedTokens === undefined) return undefined;
      return Math.max(1, window - usedTokens);
    },
  };
}

export interface KimiThinkingConfig {
  readonly type: 'enabled' | 'disabled';
  readonly effort?: string;
  readonly keep?: string;
}

const KIMI_QUOTA_EXHAUSTED_ERROR_CODES = new Set(['exceeded_current_quota_error']);

const KIMI_QUOTA_EXHAUSTED_MESSAGE_PATTERNS = [
  /exceeded your current (?:token )?quota/,
  /check your account balance/,
  /insufficient balance/,
  /recharge your account|please recharge/,
  /account (?:is )?in arrears/,
] as const;

function readStringProp(value: object, key: string): string | undefined {
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : undefined;
}

function collectErrorCodes(error: object): string[] {
  const codes: string[] = [];
  let current: object | undefined = error;
  for (let depth = 0; current !== undefined && depth < 3; depth += 1) {
    const code = readStringProp(current, 'code');
    if (code !== undefined) codes.push(code);
    const type = readStringProp(current, 'type');
    if (type !== undefined) codes.push(type);
    const nested: unknown = (current as Record<string, unknown>)['error'];
    current = typeof nested === 'object' && nested !== null ? nested : undefined;
  }
  return codes;
}

export function classifyKimiQuotaError(error: unknown): LlmRemoteErrorMessage | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ((error as Record<string, unknown>)['status'] !== 429) return undefined;
  const message = readStringProp(error, 'message') ?? '';
  const lowerMessage = message.toLowerCase();
  const structuredHit = collectErrorCodes(error).some((code) =>
    KIMI_QUOTA_EXHAUSTED_ERROR_CODES.has(code),
  );
  const wordingHit = KIMI_QUOTA_EXHAUSTED_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(lowerMessage),
  );
  if (!structuredHit && !wordingHit) return undefined;
  const headers = (error as Record<string, unknown>)['headers'];
  return {
    kind: 'quota_exhausted',
    message,
    statusCode: 429,
    requestId: readStringProp(error, 'requestID') ?? null,
    retryAfterMs: parseRetryAfterMs(headers),
    headers: headersToRecord(headers),
  };
}

function withKimiErrors(base: { readonly decodeError: (error: unknown) => LlmRemoteErrorMessage }) {
  return (error: unknown) => classifyKimiQuotaError(error) ?? base.decodeError(error);
}

function isEffectivelyEmptyContent(parts: readonly ContentPart[]): boolean {
  return parts.every((part) => part.type === 'text' && part.text.trim() === '');
}

function convertKimiTool(tool: ToolDescription): Record<string, unknown> {
  if (tool.name.startsWith('$')) {
    return { type: 'builtin_function', function: { name: tool.name } };
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeKimiToolSchema(tool.parameters),
    },
  };
}

function keepsAllThinking(module: LlmModule<OpenAIOptions>): boolean {
  return module.model.thinking?.keep === 'all' && module.model.thinking.effort !== 'off';
}

function convertKimiMessage(
  message: Message,
  converted: OpenAINativeMessage,
  module: LlmModule<OpenAIOptions>,
): OpenAINativeMessage {
  if (message.role === 'system') {
    if (message.tools === undefined || message.tools.length === 0) return converted;
    return { ...converted, tools: message.tools.map(convertKimiTool) };
  }
  if (message.role !== 'assistant' || converted.role !== 'assistant') return converted;
  const toolCalls = converted.tool_calls?.map((toolCall, index) => {
    const extras = message.toolCalls[index]?.extras;
    return extras === undefined ? toolCall : { ...toolCall, extras };
  });
  const dropContent =
    message.toolCalls.length > 0 &&
    isEffectivelyEmptyContent(message.content.filter((part) => part.type !== 'think'));
  const { content: _content, ...withoutContent } = converted;
  const result = withReasoningDetails(message, {
    ...(dropContent ? withoutContent : converted),
    tool_calls: toolCalls,
  });
  const hasReasoning = OPENAI_REASONING_KEYS.some((key) => key in result);
  return keepsAllThinking(module) && !hasReasoning ? { ...result, reasoning_content: '' } : result;
}

function isUsage(value: unknown): value is OpenAIRawUsage {
  return typeof value === 'object' && value !== null;
}

function hoistKimiUsage(payload: OpenAIRawChunk): OpenAIRawChunk {
  if (isUsage(payload.usage)) return payload;
  const choiceUsage = (payload.choices?.[0] as { usage?: unknown } | undefined)?.usage;
  return isUsage(choiceUsage) ? { ...payload, usage: choiceUsage } : payload;
}

export const kimiOpenAIProtocol = openAIProtocol.with((base) => ({
  media: kimiMedia(base.media, { video: KIMI_UPLOADED_VIDEO }),
  requestId: kimiRequestId,
  legality: { ...kimiLegality(base), strictThinkingEfforts: true },
  thinking: (thinking) => {
    if (thinking === undefined) return undefined;
    const config: KimiThinkingConfig =
      thinking.effort === 'off'
        ? { type: 'disabled', keep: thinking.keep }
        : {
            type: 'enabled',
            effort: thinking.effort === 'on' ? undefined : thinking.effort,
            keep: thinking.keep,
          };
    return { thinking: config };
  },
  maxOutputTokens: (maxOutputTokens) => ({ max_completion_tokens: maxOutputTokens }),
  tool: convertKimiTool,
  message: (message, module) =>
    base.message(message, module).map((native) => convertKimiMessage(message, native, module)),
  decoder: (module, sink) => {
    const inner = base.decoder(module, sink);
    let seenReasoningContent = false;
    return {
      push(chunk) {
        const delta = chunk.choices?.[0]?.delta;
        seenReasoningContent ||= hasReasoningContent(delta);
        decodeReasoningDetails(delta, sink, seenReasoningContent);
        inner.push(hoistKimiUsage(chunk));
      },
      end: inner.end,
    };
  },
  decodeError: withKimiErrors(base),
}));

export const kimiAnthropicProtocol = anthropicProtocol.with((base) => ({
  media: kimiMedia(base.media),
  requestId: kimiRequestId,
  thinking: (thinking) => {
    if (thinking === undefined) return undefined;
    return thinking.effort === 'off'
      ? { thinking: { type: 'disabled' }, betas: [CONTEXT_MANAGEMENT_BETA] }
      : {
          thinking: { type: 'enabled' },
          output_config: thinking.effort === 'on' ? undefined : { effort: thinking.effort },
          betas: [CONTEXT_MANAGEMENT_BETA],
        };
  },
  decodeError: withKimiErrors(base),
}));

export const kimiResponsesProtocol = openAIResponsesProtocol.with((base) => ({
  media: kimiMedia(base.media),
  requestId: kimiRequestId,
  legality: kimiLegality(base),
  decodeError: withKimiErrors(base),
}));
