/**
 * `kosong/provider` domain (L2) — side-effect module: the Kimi vendor
 * registration, one definition per transport Kimi runs over, each driven by
 * a single trait object.
 *
 * Kimi is not a wire protocol — it is a set of vendor registrations:
 *
 *  - `(kimi, openai)`, driven by `kimiOpenAITrait`, declaring every deviation
 *    from the OpenAI base on Kimi's native transport:
 *     - request params: the `KIMI_API_KEY` / `KIMI_BASE_URL` endpoint
 *       fallback chain and the default base URL; `cacheKey` →
 *       `prompt_cache_key`; `withThinking` → `extra_body.thinking`
 *       (`{ type: 'disabled' | 'enabled', effort? }`, carrying the per-turn
 *       `keep` when present); `withMaxCompletionTokens` →
 *       `max_completion_tokens` with NO 128k ceiling (the base's window
 *       clamp has already run; the trait takes over the ceiling); and
 *       `buildParams` (the last hook before send) backfills `max_tokens` →
 *       `max_completion_tokens`, drops `max_tokens`, and expands
 *       `extra_body` into the top-level params;
 *     - `strictThinkingValidation` (a metadata marker, not a hook — the v1
 *       parity contract): Kimi's native API rejects thinking efforts the
 *       model metadata does not list, so client-side validation must be
 *       strict when this trait drives thinking;
 *     - tools: `convertTool` emits `$`-prefixed tool names as
 *       `builtin_function` declarations; every other tool goes through the
 *       base OpenAI conversion with its parameters normalized into the Kimi
 *       schema dialect (`normalizeKimiToolSchema` from `./kimi-schema`);
 *     - messages: `convertMessage` post-processes each base-converted wire
 *       message — assistant tool-call messages whose content is effectively
 *       empty drop the `content` field entirely, `tool_calls[].extras`
 *       round-trips from the contract message into the wire shape (the base
 *       conversion never emits `extras`), and message-level `tools`
 *       declarations are embedded into the message;
 *     - reasoning: `reasoningKey` names the wire field carrying reasoning
 *       content (`reasoning_content`, used for both inbound extraction and
 *       outbound replay); `preserveThinking` force-replays it in a
 *       `keep: 'all'` session with thinking not disabled — it reads the
 *       already-seeded request kwargs (the thinking config `withThinking`
 *       just encoded), so it decides per request, not per instance;
 *     - usage: `extractUsage` finds the usage payload of a Kimi stream chunk
 *       either at the top level (the base's default location) or inside
 *       `choices[0].usage`; returning `undefined` defers to the base default
 *       when neither position carries one;
 *     - video upload: `uploadVideo` uploads through the Kimi files API
 *       (`KimiFiles` from `./kimi-files`), memoized per trait context with a
 *       WeakMap — one composition (one resolved ctx) gets one files client,
 *       derived from the same endpoint fallback chain the trait declares;
 *  - `(kimi, anthropic)`, driven by `kimiAnthropicTrait`: the thinking intent
 *    is encoded as `thinking: { type: 'enabled' }` plus
 *    `output_config.effort`, and the interleaved-thinking beta is stripped
 *    from the seeded beta list. The `keep` dimension needs no trait handling
 *    — the Anthropic base overlays the context-management edit itself. The
 *    trait deliberately does NOT declare `strictThinkingValidation`: over
 *    this foreign transport the backend may accept efforts the local catalog
 *    metadata does not list, so client-side validation stays lenient
 *    (warning + pass-through).
 *
 * Vendor-level facts — the endpoint fallback chain, full host-header
 * forwarding, OAuth-catalog model discovery, and the UNKNOWN capability
 * declaration (Kimi model capabilities come from the catalog, not from
 * client-side tables) — are shared constants declared identically on both
 * registrations, so id-level queries read either one.
 *
 * Deliberately absent (do not reintroduce): a 64-char tool-call-id policy
 * (the base default is identical), an extra-body deep-merge morph, and a
 * vendor-specific provider `name` (the composed provider's name is the
 * base's `'openai'`).
 */

import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type {
  ProtocolEndpoint,
  ProtocolTrait,
  TraitContext,
} from '#/kosong/protocol/protocolTrait';

import { type OpenAIToolParam, toolToOpenAI } from '../../bases/openai/openai-common';
import { registerProviderDefinition } from '../../providerDefinition';
import { KimiFiles } from './kimi-files';
import { normalizeKimiToolSchema } from './kimi-schema';

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

export const KIMI_REASONING_KEY = 'reasoning_content';

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
  // v1 parity contract: Kimi's native API rejects unlisted thinking efforts,
  // so the profile validates strictly when this trait drives thinking.
  strictThinkingValidation: true,

  endpoint: () => ({
    apiKeyEnv: KIMI_API_KEY_ENV,
    baseUrlEnv: KIMI_BASE_URL_ENV,
    defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
  }),

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

  reasoningKey: () => KIMI_REASONING_KEY,

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
      // extra_body expands last — its keys win over top-level kwargs.
      Object.assign(out, extraBody);
    }
    return out;
  },

  convertTool: (tool) => convertKimiTool(tool),

  convertMessage: (message, converted) => {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const nonThinkParts = message.content.filter((part) => part.type !== 'think');
      if (isEffectivelyEmptyContent(nonThinkParts)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
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

/** The vendor-level endpoint declaration, shared by both registrations. */
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
  capability: UNKNOWN_CAPABILITY,
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  traits: [kimiAnthropicTrait],
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
  capability: UNKNOWN_CAPABILITY,
});
