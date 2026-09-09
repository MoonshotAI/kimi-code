import type { ProtocolEndpoint, ProviderConnection } from '#/llm/protocol/connection';
import type { ContentPart, ToolDescription } from '#/llm/message';
import type { AnthropicTrait } from '#/llm/requester/bases/anthropic/trait';
import { CONTEXT_MANAGEMENT_BETA } from '#/llm/requester/bases/anthropic/format';
import type { OpenAITrait } from '#/llm/requester/bases/openai/trait';
import type { OpenAIWireToolCall } from '#/llm/requester/bases/openai/lower';

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

export const kimiOpenAITrait: OpenAITrait = {
  strictThinkingValidation: true,

  toolMessageConversion: 'keep_parts',

  cacheKey: (key) => ({ prompt_cache_key: key }),

  thinking: (thinking) => {
    const config: KimiThinkingConfig =
      thinking.effort === 'off'
        ? { type: 'disabled' }
        : thinking.effort === 'on'
          ? { type: 'enabled' }
          : { type: 'enabled', effort: thinking.effort };
    if (thinking.keep !== undefined) {
      config.keep = thinking.keep;
    }
    return {
      kwargs: { thinking: config },
      preserveThinking: thinking.keep === 'all' && thinking.effort !== 'off' ? true : undefined,
    };
  },

  maxCompletionTokens: (maxCompletionTokens) => ({
    max_completion_tokens: maxCompletionTokens,
  }),

  buildParams: (params) => {
    const { extra_body: extraBody, ...rest } = params;
    if (extraBody === undefined || extraBody === null) {
      return params;
    }
    return { ...rest, ...(extraBody as Record<string, unknown>) };
  },

  convertTool: (tool) => convertKimiTool(tool),

  convertMessage: (message, converted) => {
    const record = converted as Record<string, unknown>;
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
        const out = convertedToolCalls[index] as OpenAIWireToolCall | undefined;
        if (out !== undefined) {
          (out as Record<string, unknown>)['extras'] = toolCall.extras;
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

export const kimiAnthropicTrait: AnthropicTrait = {
  thinking: (thinking) => {
    if (thinking.effort === 'off') {
      return { kwargs: { thinking: { type: 'disabled' }, betaFeatures: [CONTEXT_MANAGEMENT_BETA] } };
    }
    return {
      kwargs: {
        thinking: { type: 'enabled' },
        output_config: thinking.effort === 'on' ? undefined : { effort: thinking.effort },
        betaFeatures: [CONTEXT_MANAGEMENT_BETA],
      },
    };
  },
};
