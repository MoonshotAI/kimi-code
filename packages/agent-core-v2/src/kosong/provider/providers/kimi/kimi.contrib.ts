import type { ContentPart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type {
  ProtocolEndpoint,
  ProtocolTrait,
  TraitContext,
} from '#/kosong/protocol/protocolTrait';

import { type OpenAIToolParam, toolToOpenAI } from '../../bases/openai/openai-common';
import { registerProviderDefinition } from '../../providerDefinition';
import { classifyKimiQuotaError } from './kimi-errors';
import { KimiFiles } from './kimi-files';
import { normalizeKimiToolSchema } from './kimi-schema';

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

export interface GenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  prompt_cache_key?: string | undefined;
  extra_body?: ExtraBody;
}

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

export function convertKimiTool(tool: Tool): OpenAIToolParam {
  if (tool.name.startsWith('$')) {
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
  }
  const converted = toolToOpenAI(tool);
  return {
    ...converted,
    function: {
      ...converted.function,
      parameters: normalizeKimiToolSchema(tool.parameters),
    },
  };
}

function isEffectivelyEmptyContent(parts: ContentPart[]): boolean {
  for (const part of parts) {
    if (part.type !== 'text') return false;
    if (part.text.trim() !== '') return false;
  }
  return true;
}

const filesByContext = new WeakMap<TraitContext, KimiFiles>();

function firstEnv(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function resolveFiles(ctx: TraitContext): KimiFiles {
  let files = filesByContext.get(ctx);
  if (files === undefined) {
    files = new KimiFiles({
      apiKey: ctx.config.apiKey ?? firstEnv(KIMI_API_KEY_ENV),
      baseUrl: ctx.config.baseUrl ?? firstEnv(KIMI_BASE_URL_ENV) ?? KIMI_DEFAULT_BASE_URL,
      defaultHeaders:
        ctx.config.defaultHeaders === undefined ? undefined : { ...ctx.config.defaultHeaders },
    });
    filesByContext.set(ctx, files);
  }
  return files;
}

export const kimiOpenAITrait: ProtocolTrait = {
  strictThinkingValidation: true,

  endpoint: () => ({
    apiKeyEnv: KIMI_API_KEY_ENV,
    baseUrlEnv: KIMI_BASE_URL_ENV,
    defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
  }),

  convertError: (error) => classifyKimiQuotaError(error),

  cacheKey: (key) => ({ prompt_cache_key: key }),

  withThinking: (effort, options, generationKwargs) => {
    const thinking: KimiThinkingConfig =
      effort === 'off'
        ? { type: 'disabled' }
        : effort === 'on'
          ? { type: 'enabled' }
          : { type: 'enabled', effort };
    if (options.keep !== undefined) {
      thinking.keep = options.keep;
    }
    const extraBody = generationKwargs['extra_body'] as ExtraBody | undefined;
    return { extra_body: { ...extraBody, thinking } };
  },

  preserveThinking: (generationKwargs) => {
    const extraBody = generationKwargs['extra_body'] as ExtraBody | undefined;
    const thinking = extraBody?.thinking;
    if (thinking?.keep === 'all' && thinking.type !== 'disabled') {
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

    const convertedToolCalls = converted['tool_calls'];
    if (Array.isArray(convertedToolCalls)) {
      message.toolCalls.forEach((toolCall, index) => {
        if (toolCall.extras === undefined) return;
        const out = convertedToolCalls[index] as Record<string, unknown> | undefined;
        if (out !== undefined) {
          out['extras'] = toolCall.extras;
        }
      });
    }

    if (message.tools !== undefined && message.tools.length > 0) {
      converted['tools'] = message.tools.map((tool) => convertKimiTool(tool));
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

  uploadVideo: (input, options, ctx) => resolveFiles(ctx).uploadVideo(input, options),
};

export const kimiAnthropicTrait: ProtocolTrait = {
  convertError: (error) => classifyKimiQuotaError(error),

  withThinking: (effort, _options, generationKwargs) => {
    const seeded = generationKwargs['betaFeatures'];
    const betaFeatures = (Array.isArray(seeded) ? (seeded as string[]) : []).filter(
      (beta) => beta !== INTERLEAVED_THINKING_BETA,
    );
    if (effort === 'off') {
      return {
        thinking: { type: 'disabled' },
        output_config: undefined,
        betaFeatures,
      };
    }
    return {
      thinking: { type: 'enabled' },
      output_config: effort === 'on' ? undefined : { effort },
      betaFeatures,
    };
  },
};

const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai',
  traits: [kimiOpenAITrait],
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  traits: [kimiAnthropicTrait],
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});
