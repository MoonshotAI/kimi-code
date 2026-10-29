import type { Message, ToolDescription, ContentPart } from '#/llm/message';
import { providerImagePolicy } from '#/llm/protocol/kit/media';
import { requestIdFromHeader } from '#/llm/protocol/kit/http';
import type { Decoder, LlmErrorDiagnosticsInput } from '#/llm/protocol/protocol';
import type { LlmModelSpec, ThinkingRequestOptions } from '#/llm/request';
import { llmStatusErrorMessage, type LlmRemoteErrorMessage } from '#/llm/response';
import {
  anthropicProtocol,
  CONTEXT_MANAGEMENT_BETA,
  lowerMessage as lowerAnthropicMessage,
} from '#/llm/builtin/protocol/anthropic/index';
import {
  lowerMessage as lowerOpenAIMessage,
  openAIModelLegality,
  openAIProtocol,
  resolveOpenAIReasoningKey,
  type OpenAINativeMessage,
  type OpenAINativeToolCall,
  type OpenAILowerContext,
  type OpenAIRawChunk,
  type OpenAIRawUsage,
} from '#/llm/builtin/protocol/openai/index';
import {
  openAIResponsesModelLegality,
  openAIResponsesProtocol,
} from '#/llm/builtin/protocol/openai-responses/index';

import { classifyKimiQuotaError } from './errors';
import { normalizeKimiToolSchema } from './schema';

export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

export interface KimiThinkingConfig {
  type?: 'enabled' | 'disabled';
  effort?: string;
  keep?: unknown;
  [key: string]: unknown;
}

function isEffectivelyEmptyContent(parts: readonly ContentPart[]): boolean {
  for (const part of parts) {
    if (part.type !== 'text') {
      return false;
    }
    if (part.text.trim() !== '') {
      return false;
    }
  }
  return true;
}

function convertKimiTool(tool: ToolDescription): Record<string, unknown> {
  if (tool.name.startsWith('$')) {
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
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

function fillKimiMaxOutputTokens(
  model: LlmModelSpec,
  usedTokens: number | undefined,
): number | undefined {
  const window = model.maxContextSize;
  if (window === undefined || window <= 0 || usedTokens === undefined) return undefined;
  return Math.max(1, window - usedTokens);
}

function kimiOpenAIThinkingParams(thinking: ThinkingRequestOptions): Record<string, unknown> {
  const config: KimiThinkingConfig =
    thinking.effort === 'off'
      ? { type: 'disabled' }
      : thinking.effort === 'on'
        ? { type: 'enabled' }
        : { type: 'enabled', effort: thinking.effort };
  if (thinking.keep !== undefined) {
    config.keep = thinking.keep;
  }
  return { thinking: config };
}

function applyKimiMessageExtras(
  message: Message,
  native: OpenAINativeMessage,
): OpenAINativeMessage {
  const record = native as Partial<OpenAINativeMessage> & Record<string, unknown>;
  if (message.role === 'assistant' && message.toolCalls.length > 0) {
    const nonThinkParts = message.content.filter((part) => part.type !== 'think');
    if (isEffectivelyEmptyContent(nonThinkParts)) {
      delete record['content'];
    }
  }
  if (message.role === 'system' && message.tools !== undefined && message.tools.length > 0) {
    record['tools'] = message.tools.map((tool) => convertKimiTool(tool));
  }
  const convertedToolCalls = record['tool_calls'];
  if (message.role === 'assistant' && Array.isArray(convertedToolCalls)) {
    message.toolCalls.forEach((toolCall, index) => {
      if (toolCall.extras === undefined) {
        return;
      }
      const out: (OpenAINativeToolCall & { extras?: unknown }) | undefined =
        convertedToolCalls[index];
      if (out !== undefined) {
        out.extras = toolCall.extras;
      }
    });
  }
  return native;
}

function hoistKimiUsage(chunk: OpenAIRawChunk): OpenAIRawChunk {
  if (chunk.usage !== null && chunk.usage !== undefined && typeof chunk.usage === 'object') {
    return chunk;
  }
  const firstChoice = chunk.choices?.[0] as { usage?: OpenAIRawUsage | null } | undefined;
  const choiceUsage = firstChoice?.usage;
  if (choiceUsage === null || choiceUsage === undefined || typeof choiceUsage !== 'object') {
    return chunk;
  }
  return { ...chunk, usage: choiceUsage };
}

const kimiImageMimes = providerImagePolicy('kimi').acceptedMimes;

function withKimiErrors(base: { readonly decodeError: (error: unknown) => LlmRemoteErrorMessage }) {
  return (error: unknown) => classifyKimiQuotaError(error) ?? base.decodeError(error);
}

function diagnoseKimiError({ error, headers }: LlmErrorDiagnosticsInput) {
  const currentHeaders = headers ?? llmStatusErrorMessage(error)?.headers ?? undefined;
  const requestId =
    currentHeaders === undefined ? undefined : requestIdFromHeader('x-trace-id')(currentHeaders);
  return requestId === undefined ? {} : { requestId };
}

export const kimiOpenAIProtocol = openAIProtocol.with((base) => ({
  requestId: requestIdFromHeader('x-trace-id'),
  diagnoseError: diagnoseKimiError,
  legality: {
    ...openAIModelLegality,
    fillMaxOutputTokens: fillKimiMaxOutputTokens,
  },
  thinking: (thinking) => (thinking === undefined ? undefined : kimiOpenAIThinkingParams(thinking)),
  maxOutputTokens: (cap) => ({ max_completion_tokens: cap }),
  tool: convertKimiTool,
  message: (message, module) => {
    const ctx: OpenAILowerContext = {
      reasoningKey: resolveOpenAIReasoningKey(
        module.content.messages,
        module.options?.reasoningKey,
        module.options?.detectedReasoningKey,
      ),
      preserveThinking:
        module.model.thinking?.keep === 'all' && module.model.thinking?.effort !== 'off',
      toolMessageConversion: module.options?.toolMessageConversion ?? 'keep_parts',
    };
    return lowerOpenAIMessage(message, ctx).map((native) => applyKimiMessageExtras(message, native));
  },
  decoder: (module, sink): Decoder<OpenAIRawChunk> => {
    const inner = base.decoder(module, sink);
    return {
      push: (chunk) => inner.push(hoistKimiUsage(chunk)),
      end: () => inner.end(),
    };
  },
  flatten: (native, module) => {
    const { extra_body: extraBody, ...extras } = module.options?.extras ?? {};
    const options = { ...module.options, extras: { ...extras, ...extraBody } };
    return base.flatten(native, { ...module, options });
  },
  decodeError: withKimiErrors(base),
}));

export const kimiAnthropicProtocol = anthropicProtocol.with((base) => ({
  requestId: requestIdFromHeader('x-trace-id'),
  diagnoseError: diagnoseKimiError,
  thinking: (thinking) =>
    thinking === undefined
      ? undefined
      : thinking.effort === 'off'
        ? { thinking: { type: 'disabled' }, betaFeatures: [CONTEXT_MANAGEMENT_BETA] }
        : {
            thinking: { type: 'enabled' },
            output_config: thinking.effort === 'on' ? undefined : { effort: thinking.effort },
            betaFeatures: [CONTEXT_MANAGEMENT_BETA],
          },
  message: (message) => lowerAnthropicMessage(message, kimiImageMimes),
  decodeError: withKimiErrors(base),
}));

export const kimiResponsesProtocol = openAIResponsesProtocol.with((base) => ({
  requestId: requestIdFromHeader('x-trace-id'),
  diagnoseError: diagnoseKimiError,
  legality: {
    ...openAIResponsesModelLegality,
    fillMaxOutputTokens: fillKimiMaxOutputTokens,
  },
  decodeError: withKimiErrors(base),
}));

