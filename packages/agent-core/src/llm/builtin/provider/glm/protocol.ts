import { openAIProtocol, type OpenAINativeMessage, type OpenAIRawChunk } from '#/llm/builtin/protocol/openai/index';
import { ThinkingConfigError } from '#/llm/protocol/errors';
import type { DecodeSink } from '#/llm/protocol/protocol';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type { ModelCapability, ThinkingRequestOptions } from '#/llm/request';
import {
  llmStatusErrorMessage,
  type LlmRemoteErrorMessage,
  type LlmStatusErrorKind,
} from '#/llm/response';

type GlmEffortSupport = 'tiered' | 'passthrough' | 'none';

interface GlmModelProfile {
  readonly forcedThinking: boolean;
  readonly efforts: GlmEffortSupport;
}

const TIERED_EFFORTS: Readonly<Record<string, string>> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
};

const GLM_ERROR_KINDS: Readonly<Record<string, LlmStatusErrorKind>> = {
  '1113': 'quota_exhausted',
  '1261': 'context_overflow',
  '1305': 'overloaded',
  '1308': 'quota_exhausted',
  '1309': 'quota_exhausted',
  '1310': 'quota_exhausted',
  '1311': 'quota_exhausted',
  '1313': 'quota_exhausted',
  '1314': 'quota_exhausted',
  '1315': 'quota_exhausted',
  '1316': 'quota_exhausted',
  '1317': 'quota_exhausted',
  '1318': 'quota_exhausted',
  '1319': 'quota_exhausted',
  '1320': 'quota_exhausted',
  '1321': 'quota_exhausted',
};

const GLM_FINISH_REASONS: Readonly<Record<string, string>> = {
  sensitive: 'content_filter',
  model_context_window_exceeded: 'length',
};

function glmProfile(modelName: string): GlmModelProfile {
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('glm-5.3')) return { forcedThinking: true, efforts: 'tiered' };
  if (normalized.startsWith('glm-5.2')) return { forcedThinking: false, efforts: 'passthrough' };
  return { forcedThinking: false, efforts: 'none' };
}

export function inferGlmCapability(modelName: string): ModelCapability | undefined {
  const normalized = modelName.toLowerCase();
  if (!normalized.startsWith('glm-')) return undefined;
  const vision = /^glm-(?:5\.3-flash|5v|4\.\d+v|4v)/.test(normalized);
  return {
    image_in: vision,
    video_in: vision,
    audio_in: false,
    thinking: /^glm-(?:5|4\.[5-9]|4\.1v-thinking)/.test(normalized),
    tool_use: true,
  };
}

const glmMedia: MediaSupport = {
  kinds: {
    image: { mimes: new Set(['image/png', 'image/jpeg']), sources: ['inline', 'url'], inToolResult: 'relocate' },
    video: { mimes: 'any', sources: ['url'], inToolResult: 'relocate' },
  },
};

function encodeGlmThinking(thinking: ThinkingRequestOptions, modelName: string): Record<string, unknown> {
  const profile = glmProfile(modelName);
  if (thinking.effort === 'off') {
    if (profile.forcedThinking) {
      throw new ThinkingConfigError(
        'thinking-cannot-disable',
        `Model '${modelName}' always reasons and thinking cannot be turned off. Choose low, high or max instead of 'off'.`,
      );
    }
    return { thinking: { type: 'disabled' } };
  }
  const type = thinking.keep === undefined ? { type: 'enabled' } : { type: 'enabled', clear_thinking: false };
  if (thinking.effort === 'on' || profile.efforts === 'none') return { thinking: type };
  if (profile.efforts === 'passthrough') return { thinking: type, reasoning_effort: thinking.effort };
  const effort = TIERED_EFFORTS[thinking.effort];
  if (effort === undefined) {
    throw new ThinkingConfigError(
      'effort-unsupported',
      `Model '${modelName}' supports the thinking efforts low, high and max; '${thinking.effort}' cannot be mapped.`,
    );
  }
  return { thinking: type, reasoning_effort: effort };
}

function flattenTextContent(native: OpenAINativeMessage): OpenAINativeMessage {
  const { content } = native;
  if (!Array.isArray(content) || !content.every((part) => part.type === 'text')) return native;
  return { ...native, content: content.map((part) => part.text ?? '').join('\n') } as OpenAINativeMessage;
}

function withGlmFinishReasons(payload: OpenAIRawChunk): OpenAIRawChunk {
  const choices = payload.choices;
  if (choices === undefined || !choices.some((choice) => (choice.finish_reason ?? '') in GLM_FINISH_REASONS)) {
    return payload;
  }
  return {
    ...payload,
    choices: choices.map((choice) => {
      const mapped = GLM_FINISH_REASONS[choice.finish_reason ?? ''];
      return mapped === undefined ? choice : { ...choice, finish_reason: mapped };
    }),
  };
}

function failedInference(payload: OpenAIRawChunk, sink: DecodeSink): boolean {
  if (!payload.choices?.some((choice) => choice.finish_reason === 'network_error')) return false;
  sink.onError({ kind: 'provider', message: 'GLM inference failed (finish_reason: network_error).' });
  return true;
}

function businessCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, error: body } = error as { code?: unknown; error?: { code?: unknown } };
  const value = code ?? body?.code;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function withGlmErrors(base: { readonly decodeError: (error: unknown) => LlmRemoteErrorMessage }) {
  return (error: unknown): LlmRemoteErrorMessage => {
    const decoded = base.decodeError(error);
    const status = llmStatusErrorMessage(decoded);
    const code = businessCodeOf(error);
    const kind = code === undefined ? undefined : GLM_ERROR_KINDS[code];
    return status === null || kind === undefined ? decoded : ({ ...status, kind } as LlmRemoteErrorMessage);
  };
}

export const glmProtocol = openAIProtocol.with((base) => ({
  media: glmMedia,
  capability: inferGlmCapability,
  legality: { ...base.legality, sampling: ['temperature', 'topP', 'stop'], responseFormats: ['json_object'] },
  cacheKey: undefined,
  thinking: (thinking, module) =>
    thinking === undefined ? undefined : encodeGlmThinking(thinking, module.model.spec.name),
  message: (message, module) => base.message(message, module).map(flattenTextContent),
  decoder: (module, sink) => {
    const inner = base.decoder(module, sink);
    return {
      push(chunk) {
        if (failedInference(chunk, sink)) return;
        inner.push(withGlmFinishReasons(chunk));
      },
      end: inner.end,
    };
  },
  decodeError: withGlmErrors(base),
}));
