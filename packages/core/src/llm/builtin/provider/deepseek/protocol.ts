import {
  anthropicProtocol,
  type AnthropicNativeMessage,
  type AnthropicNativePart,
} from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol, type OpenAINativeMessage } from '#/llm/builtin/protocol/openai/index';
import {
  BASELINE_IMAGE_MIMES,
  BASELINE_INLINE_IMAGE_BYTE_BUDGET,
} from '#/llm/protocol/kit/media';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { ModelCapability, ResponseFormat } from '#/llm/request';
import type { LlmRemoteErrorMessage } from '#/llm/response';

export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;

const MAX_IMAGE_URL_LENGTH = 8192;
const FILES_API_BETA = 'files-api-2025-04-14';

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
  if (normalized.startsWith('deepseek-v4-pro') || normalized.startsWith('claude-opus')) {
    return DEEPSEEK_TEXT_CAPABILITY;
  }
  if (
    normalized === 'deepseek-flash' ||
    normalized.startsWith('deepseek-v4-flash') ||
    normalized.startsWith('claude-')
  ) {
    return DEEPSEEK_VISION_CAPABILITY;
  }
  return undefined;
}

function deepseekMedia(inToolResult: 'native' | 'relocate'): MediaSupport {
  return {
    kinds: {
      image: {
        mimes: BASELINE_IMAGE_MIMES,
        sources: ['inline', 'url', 'file'],
        url: (url) => /^https?:\/\//i.test(url) && url.length <= MAX_IMAGE_URL_LENGTH,
        inToolResult,
        inlineByteBudget: BASELINE_INLINE_IMAGE_BYTE_BUDGET,
      },
    },
  };
}

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

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status } = error as { status?: unknown };
  return typeof status === 'number' ? status : undefined;
}

function withDeepSeekErrors(base: {
  readonly decodeError: (error: unknown, source?: 'stream') => LlmRemoteErrorMessage;
}) {
  return (error: unknown, source?: 'stream'): LlmRemoteErrorMessage => {
    const decoded = base.decodeError(error, source);
    const status = decoded.kind === 'status' ? decoded.statusCode : statusOf(error);
    return status === 402
      ? ({ ...decoded, kind: 'quota_exhausted', retryable: false } as LlmRemoteErrorMessage)
      : decoded;
  };
}

function fileId(url: string): string | undefined {
  return url.startsWith('ms://') ? url.slice(5) : undefined;
}

function withDeepSeekOpenAIFiles(native: OpenAINativeMessage): OpenAINativeMessage {
  if (!Array.isArray(native.content)) return native;
  return {
    ...native,
    content: native.content.map((part) => {
      if (part.type !== 'image_url') return part;
      const source = part.image_url as { url?: string; id?: string };
      const id = fileId(source.url ?? '');
      if (id !== undefined) return { type: 'file', file_id: id };
      if (source.id === undefined) return part;
      return { ...part, image_url: { url: source.url ?? '' } };
    }),
  } as unknown as OpenAINativeMessage;
}

function withDeepSeekAnthropicFiles(part: AnthropicNativePart): AnthropicNativePart {
  if (part.type === 'image' && part.source.type === 'url') {
    const id = fileId(part.source.url);
    if (id !== undefined) {
      return {
        type: 'image',
        source: { type: 'file', file_id: id },
        cache_control: part.cache_control,
      } as unknown as AnthropicNativePart;
    }
  }
  if (part.type === 'tool_result') {
    return { ...part, content: part.content.map(withDeepSeekAnthropicFiles) };
  }
  return part;
}

function hasAnthropicFile(part: AnthropicNativePart): boolean {
  if (part.type === 'image') {
    const source = part.source as { type: string; url?: string };
    return source.type === 'file' || (source.type === 'url' && fileId(source.url ?? '') !== undefined);
  }
  return part.type === 'tool_result' && part.content.some(hasAnthropicFile);
}

function withDeepSeekAnthropicMessage(native: AnthropicNativeMessage): AnthropicNativeMessage {
  return { ...native, content: native.content.map(withDeepSeekAnthropicFiles) };
}

export const deepseekOpenAIProtocol = openAIProtocol.with((base) => ({
  media: deepseekMedia('relocate'),
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
  message: (message, module) => base.message(message, module).map(withDeepSeekOpenAIFiles),
  decodeError: withDeepSeekErrors(base),
}));

export const deepseekAnthropicProtocol = anthropicProtocol.with((base) => ({
  media: deepseekMedia('native'),
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
  message: (message, module) => base.message(message, module).map(withDeepSeekAnthropicMessage),
  finalize: (native, module) => {
    const finalized = base.finalize?.(native, module) ?? native;
    if (!native.messages.some((message) => message.content.some(hasAnthropicFile))) return finalized;
    const betaFeatures = finalized.params.betaFeatures ?? [];
    return {
      ...finalized,
      params: {
        ...finalized.params,
        betaFeatures: betaFeatures.includes(FILES_API_BETA)
          ? betaFeatures
          : [...betaFeatures, FILES_API_BETA],
      },
    };
  },
  decodeError: withDeepSeekErrors(base),
}));
