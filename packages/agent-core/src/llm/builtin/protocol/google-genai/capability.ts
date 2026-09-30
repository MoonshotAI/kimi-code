import type { ModelCapability } from '#/llm/request';

const GEMINI_CATALOGUED_PREFIXES = [
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

const GEMINI_MULTIMODAL_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: false,
  tool_use: true,
});

const GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  ...GEMINI_MULTIMODAL_TOOL_CAPABILITY,
  thinking: true,
});

export function inferGoogleGenAICapability(modelName: string): ModelCapability | undefined {
  const normalized = modelName.toLowerCase();
  if (!GEMINI_CATALOGUED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return undefined;
  }
  return normalized.startsWith('gemini-2.5-') || normalized.includes('thinking')
    ? GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY
    : GEMINI_MULTIMODAL_TOOL_CAPABILITY;
}
