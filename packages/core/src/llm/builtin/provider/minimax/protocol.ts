import {
  anthropicProtocol,
  type AnthropicNativeMessage,
  type AnthropicNativePart,
  type AnthropicRequest,
} from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol, type OpenAIRawChunk } from '#/llm/builtin/protocol/openai/index';
import type { Message } from '#/llm/message';
import { ThinkingConfigError } from '#/llm/protocol/errors';
import { requestIdFromHeader } from '#/llm/protocol/kit/http';
import { BASELINE_IMAGE_MIMES } from '#/llm/protocol/kit/media';
import type { DecodeSink } from '#/llm/protocol/protocol';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { ModelCapability, ThinkingRequestOptions } from '#/llm/request';

import { miniMaxBusinessErrorOf, miniMaxErrorMessage, withMiniMaxErrors } from './errors';

export const MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS = 131_072;
export const MINIMAX_MAX_OUTPUT_TOKENS = 524_288;

const MINIMAX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MINIMAX_IMAGE_MIMES = BASELINE_IMAGE_MIMES;
const MINIMAX_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/avi',
  'video/x-msvideo',
  'video/mov',
  'video/quicktime',
  'video/x-matroska',
]);

interface MiniMaxModelProfile {
  readonly forcedThinking: boolean;
  readonly adjustableEffort: boolean;
}

function miniMaxProfile(modelName: string): MiniMaxModelProfile {
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('minimax-m3.1-flash')) return { forcedThinking: true, adjustableEffort: true };
  return { forcedThinking: false, adjustableEffort: false };
}

export function inferMiniMaxCapability(modelName: string): ModelCapability | undefined {
  const normalized = modelName.toLowerCase();
  if (!normalized.startsWith('minimax-m3')) return undefined;
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: true,
    tool_use: true,
  };
}

function miniMaxMedia(
  imageInToolResult: 'native' | 'relocate',
  videoInToolResult: 'native' | 'relocate',
): MediaSupport {
  return {
    kinds: {
      image: {
        mimes: MINIMAX_IMAGE_MIMES,
        sources: ['inline', 'url'],
        inToolResult: imageInToolResult,
        inlineByteBudget: 10 * 1024 * 1024,
      },
      video: {
        mimes: MINIMAX_VIDEO_MIMES,
        sources: ['inline', 'url'],
        inToolResult: videoInToolResult,
        inlineByteBudget: 50 * 1024 * 1024,
      },
    },
  };
}

function miniMaxLegality(base: ModelLegality): ModelLegality {
  return {
    ...base,
    sampling: ['temperature', 'topP'],
    responseFormats: [],
    clampMaxOutputTokens: (maxOutputTokens, model) =>
      Math.min(base.clampMaxOutputTokens?.(maxOutputTokens, model) ?? maxOutputTokens, MINIMAX_MAX_OUTPUT_TOKENS),
    fillMaxOutputTokens: () => MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

function encodeMiniMaxThinking(
  thinking: ThinkingRequestOptions,
  modelName: string,
  protocol: 'openai' | 'anthropic',
): Record<string, unknown> {
  const profile = miniMaxProfile(modelName);
  if (thinking.effort === 'off' || thinking.effort === 'none') {
    if (profile.forcedThinking) {
      throw new ThinkingConfigError(
        'thinking-cannot-disable',
        `Model '${modelName}' requires adaptive thinking and cannot be turned off. Choose low, medium, high, xhigh or max instead.`,
      );
    }
    return { thinking: { type: 'disabled' } };
  }
  if (thinking.effort === 'on' || !profile.adjustableEffort) {
    return { thinking: { type: 'adaptive' } };
  }
  if (!MINIMAX_EFFORTS.has(thinking.effort)) {
    throw new ThinkingConfigError(
      'effort-unsupported',
      `Model '${modelName}' supports the thinking efforts low, medium, high, xhigh and max; '${thinking.effort}' is not supported.`,
    );
  }
  return {
    thinking: { type: 'adaptive' },
    ...(protocol === 'openai'
      ? { reasoning_effort: thinking.effort }
      : { output_config: { effort: thinking.effort } }),
  };
}

function normalizeAnthropicVideoPart(part: AnthropicNativePart): AnthropicNativePart {
  if (part.type === 'video' && part.source.type === 'base64' && part.source.media_type === 'video/quicktime') {
    return { ...part, source: { ...part.source, media_type: 'video/mov' } };
  }
  if (part.type === 'tool_result') {
    return { ...part, content: part.content.map(normalizeAnthropicVideoPart) };
  }
  return part;
}

function normalizeAnthropicVideoMessage(native: AnthropicNativeMessage): AnthropicNativeMessage {
  return { ...native, content: native.content.map(normalizeAnthropicVideoPart) };
}

function prepareAnthropicMessage(message: Message): Message {
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== 'video_url') return part;
      const url = part.videoUrl.url;
      if (!url.startsWith('data:video/mov;base64,')) return part;
      return {
        ...part,
        videoUrl: { ...part.videoUrl, url: url.replace('data:video/mov;base64,', 'data:video/quicktime;base64,') },
      };
    }),
  };
}

function withoutSystemCacheControl(request: AnthropicRequest): AnthropicRequest {
  const system = request.params.system;
  if (!Array.isArray(system)) return request;
  return {
    ...request,
    params: {
      ...request.params,
      system: system.map((block) => {
        const { cache_control: _cacheControl, ...text } = block;
        return text;
      }),
    },
  };
}

function miniMaxBusinessFailure(payload: OpenAIRawChunk, sink: DecodeSink): boolean {
  const error = miniMaxBusinessErrorOf(payload);
  if (error === undefined) return false;
  sink.onError(miniMaxErrorMessage(error));
  return true;
}

export const miniMaxOpenAIProtocol = openAIProtocol.with((base) => ({
  media: miniMaxMedia('native', 'native'),
  capability: inferMiniMaxCapability,
  legality: miniMaxLegality(base.legality),
  cacheKey: undefined,
  thinking: (thinking, module) =>
    thinking === undefined ? undefined : encodeMiniMaxThinking(thinking, module.model.spec.name, 'openai'),
  maxOutputTokens: (maxOutputTokens) => ({ max_completion_tokens: maxOutputTokens }),
  decoder: (module, sink) => {
    const inner = base.decoder(module, sink);
    return {
      push(chunk) {
        if (!miniMaxBusinessFailure(chunk, sink)) inner.push(chunk);
      },
      end() {
        inner.end();
      },
    };
  },
  requestId: requestIdFromHeader('trace_id'),
  decodeError: withMiniMaxErrors(base),
}));

export const miniMaxAnthropicProtocol = anthropicProtocol.with((base) => ({
  media: miniMaxMedia('native', 'relocate'),
  capability: inferMiniMaxCapability,
  legality: miniMaxLegality(base.legality),
  cacheKey: undefined,
  thinking: (thinking, module) =>
    thinking === undefined ? undefined : encodeMiniMaxThinking(thinking, module.model.spec.name, 'anthropic'),
  message: (message, module) =>
    base.message(prepareAnthropicMessage(message), module).map(normalizeAnthropicVideoMessage),
  annotate: (native) => native,
  finalize: (native) => native,
  flatten: (native, module) =>
    withoutSystemCacheControl(
      base.flatten(native, {
        ...module,
        model: {
          ...module.model,
          thinking: module.model.thinking === undefined ? undefined : { ...module.model.thinking, keep: undefined },
        },
        options: { ...module.options, betaApi: false },
      }),
    ),
  requestId: requestIdFromHeader('trace_id'),
  decodeError: withMiniMaxErrors(base),
}));
