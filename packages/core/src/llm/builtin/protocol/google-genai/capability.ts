const GEMINI_CATALOGUED_PREFIXES = [
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

const GEMINI_MULTIMODAL_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: false,
  tool_use: true,
});

const GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
});

export function getGoogleGenAIModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (!normalized.startsWith('gemini-')) return undefined;
  if (!GEMINI_CATALOGUED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return undefined;
  }

  if (normalized.startsWith('gemini-2.5-') || normalized.includes('thinking')) {
    return GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY;
  }
  return GEMINI_MULTIMODAL_TOOL_CAPABILITY;
}
