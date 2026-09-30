import type { CatalogModelDefinition } from '@moonshot-ai/agent-core';
import type { ManagedKimiCodeModelInfo } from '@moonshot-ai/kimi-code-oauth';

export function managedKimiCodeModelSeed(
  providerId: string,
  info: ManagedKimiCodeModelInfo,
): CatalogModelDefinition {
  return {
    id: info.id,
    provider: providerId,
    capability: {
      image_in: info.supportsImageIn,
      video_in: info.supportsVideoIn,
      audio_in: false,
      thinking:
        info.supportsThinkingType === 'only' ||
        info.supportsThinkingType === 'both' ||
        (info.supportsThinkingType === undefined && info.supportsReasoning),
      tool_use: info.supportsToolUse ?? true,
      dynamically_loaded_tools: info.supportsDynamicTools === true,
    },
    maxContextSize: info.contextLength,
  };
}
