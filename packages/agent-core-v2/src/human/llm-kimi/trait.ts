import type { ProtocolEndpoint, ProtocolTrait } from '#/llm/protocol/trait';
import type { ContentPart, ToolDescription } from '#/llm/message';
import { CONTEXT_MANAGEMENT_BETA } from '#/llm/requester/bases/anthropic/format';

import { classifyKimiQuotaError } from './errors';
import { normalizeKimiToolSchema } from './schema';

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

export interface KimiThinkingConfig {
  type?: 'enabled' | 'disabled';
  effort?: string;
  keep?: unknown;
  [key: string]: unknown;
}

export interface ExtraBody {
  thinking?: KimiThinkingConfig;
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

export const kimiOpenAITrait: ProtocolTrait = {
  strictThinkingValidation: true,

  endpoint: () => kimiEndpoint,

  convertError: (error) => classifyKimiQuotaError(error),

  toolMessageConversion: () => 'keep_parts',

  cacheKey: (key) => ({ prompt_cache_key: key }),

  withThinking: (thinking) => {
    const config: KimiThinkingConfig =
      thinking.effort === 'off'
        ? { type: 'disabled' }
        : thinking.effort === 'on'
          ? { type: 'enabled' }
          : { type: 'enabled', effort: thinking.effort };
    if (thinking.keep !== undefined) {
      config.keep = thinking.keep;
    }
    return { extra_body: { thinking: config } };
  },

  preserveThinking: (thinking) => {
    if (thinking.keep === 'all' && thinking.effort !== 'off') {
      return true;
    }
    return undefined;
  },

  withMaxCompletionTokens: (maxCompletionTokens) => ({
    max_completion_tokens: maxCompletionTokens,
  }),

  buildParams: (params) => {
    const {
      extra_body: extraBody,
      max_tokens: maxTokens,
      max_completion_tokens: maxCompletionTokens,
      ...rest
    } = params;
    const out: Record<string, unknown> = { ...rest };
    const resolvedMaxCompletionTokens = maxCompletionTokens ?? maxTokens;
    if (resolvedMaxCompletionTokens !== undefined) {
      out['max_completion_tokens'] = resolvedMaxCompletionTokens;
    }
    if (extraBody !== undefined && extraBody !== null) {
      Object.assign(out, extraBody);
    }
    return out;
  },

  convertTool: (tool) => convertKimiTool(tool),

  convertMessage: (message, converted) => {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const nonThinkParts = message.content.filter((part) => part.type !== 'think');
      if (isEffectivelyEmptyContent(nonThinkParts)) {
        delete converted['content'];
      }
    }

    if (message.role === 'system' && message.tools !== undefined && message.tools.length > 0) {
      converted['tools'] = message.tools.map((tool) => convertKimiTool(tool));
    }

    const convertedToolCalls = converted['tool_calls'];
    if (message.role === 'assistant' && Array.isArray(convertedToolCalls)) {
      message.toolCalls.forEach((toolCall, index) => {
        if (toolCall.extras === undefined) {
          return;
        }
        const out = convertedToolCalls[index] as Record<string, unknown> | undefined;
        if (out !== undefined) {
          out['extras'] = toolCall.extras;
        }
      });
    }

    return converted;
  },

  extractUsage: (chunk) => {
    const topLevel = chunk['usage'];
    if (topLevel !== null && topLevel !== undefined && typeof topLevel === 'object') {
      return topLevel as Record<string, unknown>;
    }
    const choices = chunk['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      return undefined;
    }
    const firstChoice = choices[0] as Record<string, unknown> | undefined;
    const choiceUsage = firstChoice?.['usage'];
    if (choiceUsage !== null && choiceUsage !== undefined && typeof choiceUsage === 'object') {
      return choiceUsage as Record<string, unknown>;
    }
    return undefined;
  },
};

export const kimiAnthropicTrait: ProtocolTrait = {
  endpoint: () => kimiEndpoint,

  convertError: (error) => classifyKimiQuotaError(error),

  withThinking: (thinking) => {
    if (thinking.effort === 'off') {
      return { thinking: { type: 'disabled' }, betaFeatures: [CONTEXT_MANAGEMENT_BETA] };
    }
    return {
      thinking: { type: 'enabled' },
      output_config: thinking.effort === 'on' ? undefined : { effort: thinking.effort },
      betaFeatures: [CONTEXT_MANAGEMENT_BETA],
    };
  },
};

export const kimiResponsesTrait: ProtocolTrait = {
  endpoint: () => kimiEndpoint,

  convertError: (error) => classifyKimiQuotaError(error),
};
