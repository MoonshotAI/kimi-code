import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { BASELINE_IMAGE_MIMES } from '#/llm/protocol/kit/media';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { ModelCapability, ResponseFormat } from '#/llm/request';
import type { LlmRemoteErrorMessage } from '#/llm/response';

export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;

const MAX_IMAGE_URL_LENGTH = 8192;

const DEEPSEEK_VISION_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
});

const DEEPSEEK_TEXT_CAPABILITY: ModelCapability = Object.freeze({
  ...DEEPSEEK_VISION_CAPABILITY,
  image_in: false,
});

export function inferDeepSeekCapability(modelName: string): ModelCapability | undefined {
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('deepseek-v4-pro')) return DEEPSEEK_TEXT_CAPABILITY;
  if (normalized === 'deepseek-flash' || normalized.startsWith('deepseek-v4-flash')) {
    return DEEPSEEK_VISION_CAPABILITY;
  }
  return undefined;
}

const deepseekMedia: MediaSupport = {
  kinds: {
    image: {
      mimes: BASELINE_IMAGE_MIMES,
      sources: ['inline', 'url', 'file'],
      url: (url) => /^https?:\/\//i.test(url) && url.length <= MAX_IMAGE_URL_LENGTH,
      inToolResult: 'native',
    },
  },
};

function deepseekLegality(
  base: ModelLegality,
  responseFormats: readonly ResponseFormat['type'][],
): ModelLegality {
  return {
    ...base,
    sampling: ['temperature', 'topP', 'stop'],
    responseFormats,
    clampMaxOutputTokens: (maxOutputTokens, model) =>
      Math.min(base.clampMaxOutputTokens?.(maxOutputTokens, model) ?? maxOutputTokens, DEEPSEEK_MAX_OUTPUT_TOKENS),
  };
}

function withDeepSeekErrors(base: { readonly decodeError: (error: unknown) => LlmRemoteErrorMessage }) {
  return (error: unknown): LlmRemoteErrorMessage => {
    const decoded = base.decodeError(error);
    return decoded.kind === 'status' && decoded.statusCode === 402
      ? { ...decoded, kind: 'quota_exhausted' }
      : decoded;
  };
}

export const deepseekOpenAIProtocol = openAIProtocol.with((base) => ({
  media: deepseekMedia,
  capability: inferDeepSeekCapability,
  legality: deepseekLegality(base.legality, ['json_object']),
  cacheKey: undefined,
  thinking: (thinking) => {
    if (thinking === undefined) return undefined;
    if (thinking.effort === 'off') return { thinking: { type: 'disabled' } };
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: thinking.effort === 'on' ? undefined : thinking.effort,
    };
  },
  maxOutputTokens: (maxOutputTokens) => ({ max_tokens: maxOutputTokens }),
  decodeError: withDeepSeekErrors(base),
}));

export const deepseekAnthropicProtocol = anthropicProtocol.with((base) => ({
  media: deepseekMedia,
  capability: inferDeepSeekCapability,
  legality: deepseekLegality(base.legality, []),
  thinking: (thinking) => {
    if (thinking === undefined) return undefined;
    if (thinking.effort === 'off') return { thinking: { type: 'disabled' } };
    return {
      thinking: { type: 'enabled' },
      output_config: thinking.effort === 'on' ? undefined : { effort: thinking.effort },
    };
  },
  decodeError: withDeepSeekErrors(base),
}));
