import type { CatalogModelConfig } from '#/features/provider-catalog/index';
import type { ManagedKimiCodeModelInfo } from '@moonshot-ai/kimi-code-oauth';

export function managedKimiCodeModelSeed(
  providerId: string,
  info: ManagedKimiCodeModelInfo,
): CatalogModelConfig {
  const thinking =
    info.supportsThinkingType === 'only' ||
    info.supportsThinkingType === 'both' ||
    (info.supportsThinkingType === undefined && info.supportsReasoning);
  return {
    provider: providerId,
    model: info.id,
    displayName: info.displayName,
    supportEfforts: info.supportEfforts === undefined ? undefined : [...info.supportEfforts],
    defaultEffort: info.defaultEffort,
    alwaysThinking: info.supportsThinkingType === 'only' ? true : undefined,
    adaptiveThinking: info.protocol === 'anthropic' && thinking ? true : undefined,
    protocol: info.protocol,
    betaApi: info.protocol === 'anthropic' ? true : undefined,
    capability: {
      image_in: info.supportsImageIn,
      video_in: info.supportsVideoIn,
      audio_in: false,
      thinking,
      tool_use: info.supportsToolUse ?? true,
      dynamically_loaded_tools: info.supportsDynamicTools === true,
    },
    maxContextSize: info.contextLength,
  };
}
