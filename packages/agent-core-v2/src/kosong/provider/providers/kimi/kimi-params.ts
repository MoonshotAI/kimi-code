/**
 * `kosong/provider` domain (L2) — Kimi request-params trait.
 *
 * `kimiParamsTrait` carries the endpoint declaration and the request-kwargs
 * encodings:
 *
 *  - `endpoint`: the `KIMI_API_KEY` / `KIMI_BASE_URL` env fallback chain and
 *    the default base URL;
 *  - `cacheKey` → `prompt_cache_key`;
 *  - `withThinking` → `extra_body.thinking` (`{ type: 'disabled' | 'enabled',
 *    effort? }`, carrying the per-turn `keep` when present);
 *  - `withMaxCompletionTokens` → `max_completion_tokens` with NO 128k ceiling
 *    (the base's window clamp has already run; the trait takes over the
 *    ceiling);
 *  - `buildParams` (last hook before send): backfills
 *    `max_tokens` → `max_completion_tokens`, drops `max_tokens`, and expands
 *    `extra_body` into the top-level params.
 */

import type { ProtocolTrait } from '#/kosong/protocol/protocolTrait';

export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';
export const KIMI_BASE_URL_ENV = 'KIMI_BASE_URL';
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

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

export const kimiParamsTrait: ProtocolTrait = {
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
};
