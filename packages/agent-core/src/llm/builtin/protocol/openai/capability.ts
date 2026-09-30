import type { ModelCapability } from '#/llm/request';

export const OPENAI_REASONING_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
});

export const OPENAI_VISION_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
});

const OPENAI_TEXT_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
});

const OPENAI_VISION_TOOL_PREFIXES = ['gpt-4o', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.5'] as const;

export function inferOpenAIFamilyCapability(modelName: string): ModelCapability | undefined {
  const normalized = modelName.toLowerCase();
  if (/^o\d/.test(normalized)) return OPENAI_REASONING_CAPABILITY;
  if (OPENAI_VISION_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return OPENAI_VISION_TOOL_CAPABILITY;
  }
  return undefined;
}

export function inferOpenAICapability(modelName: string): ModelCapability | undefined {
  const inferred = inferOpenAIFamilyCapability(modelName);
  if (inferred !== undefined) return inferred;
  return modelName.toLowerCase().startsWith('gpt-3.5-turbo') ? OPENAI_TEXT_TOOL_CAPABILITY : undefined;
}
