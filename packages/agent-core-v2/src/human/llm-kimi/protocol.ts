import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

import type { Message, ToolDescription } from '#/llm/message';
import type { ContentPart } from '#/llm/message';
import { providerImagePolicy } from '#/llm/media/image-formats';
import type { ProtocolBase } from '#/llm/protocol/base';
import type { ProtocolEndpoint, ProviderConnection } from '#/llm/protocol/connection';
import { requestIdFromHeader } from '#/llm/protocol/kit/http';
import type { Decoder } from '#/llm/protocol/protocol';
import type { LlmModelSpec } from '#/llm/request';
import type { ThinkingRequestOptions } from '#/llm/thinking';
import { getAnthropicModelCapability } from '#/llm/requester/bases/anthropic/capability';
import {
  anthropicProtocol,
  CONTEXT_MANAGEMENT_BETA,
  lowerMessage as lowerAnthropicMessage,
} from '#/llm/requester/bases/anthropic/protocol';
import { getOpenAILegacyModelCapability } from '#/llm/requester/bases/openai/capability';
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
} from '#/llm/requester/bases/openai/protocol';
import { getOpenAIResponsesModelCapability } from '#/llm/requester/bases/openai-responses/capability';
import {
  openAIResponsesModelLegality,
  openAIResponsesProtocol,
} from '#/llm/requester/bases/openai-responses/protocol';
import type {
  LlmClientContext,
  LlmErrorClassifier,
  LlmRequester,
} from '#/llm/requester/requester';
import { createRunRequester } from '#/llm/requester/run';

import { normalizeKimiToolSchema } from './schema';

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

export const kimiConnection: ProviderConnection = {
  endpoint: () => kimiEndpoint,
};

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
  if (chunk.usage !== null && chunk.usage !== undefined) return chunk;
  const firstChoice = chunk.choices?.[0] as { usage?: OpenAIRawUsage | null } | undefined;
  const choiceUsage = firstChoice?.usage;
  if (choiceUsage === null || choiceUsage === undefined || typeof choiceUsage !== 'object') {
    return chunk;
  }
  return { ...chunk, usage: choiceUsage };
}

const kimiImageMimes = providerImagePolicy('kimi').acceptedMimes;

export const kimiOpenAIProtocol = openAIProtocol.with((base) => ({
  requestId: requestIdFromHeader('x-trace-id'),
  legality: {
    ...openAIModelLegality,
    strictThinkingEfforts: true,
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
}));

export const kimiAnthropicProtocol = anthropicProtocol.with({
  requestId: requestIdFromHeader('x-trace-id'),
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
});

export const kimiResponsesProtocol = openAIResponsesProtocol.with({
  requestId: requestIdFromHeader('x-trace-id'),
  legality: {
    ...openAIResponsesModelLegality,
    fillMaxOutputTokens: fillKimiMaxOutputTokens,
  },
});

export interface KimiOpenAIRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
  readonly reasoningKey?: string;
}

export function createKimiOpenAIRequester(options?: KimiOpenAIRequesterOptions): LlmRequester {
  return createRunRequester(kimiOpenAIProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.openai,
      reasoningKey: options?.reasoningKey,
      toolMessageConversion: config.toolMessageConversion ?? 'keep_parts',
    }),
  });
}

export interface KimiAnthropicRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => Anthropic;
  readonly betaApi?: boolean;
}

export function createKimiAnthropicRequester(
  options?: KimiAnthropicRequesterOptions,
): LlmRequester {
  return createRunRequester(kimiAnthropicProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      betaApi: options?.betaApi === true || config.model.betaApi === true ? true : undefined,
      extras: config.extraParams?.anthropic,
    }),
  });
}

export interface KimiResponsesRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
}

export function createKimiResponsesRequester(options?: KimiResponsesRequesterOptions): LlmRequester {
  return createRunRequester(kimiResponsesProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.responses,
      toolMessageConversion: config.toolMessageConversion,
    }),
  });
}

export const kimiOpenAIBase: ProtocolBase = {
  capability: getOpenAILegacyModelCapability,
  createRequester: createKimiOpenAIRequester,
};

export const kimiAnthropicBase: ProtocolBase = {
  capability: getAnthropicModelCapability,
  createRequester: createKimiAnthropicRequester,
};

export const kimiResponsesBase: ProtocolBase = {
  capability: getOpenAIResponsesModelCapability,
  createRequester: createKimiResponsesRequester,
};
