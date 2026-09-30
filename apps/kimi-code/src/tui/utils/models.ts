import type {
  CatalogModel,
  CatalogProviderInfo,
  ModelCapability,
  ProviderCatalogFace,
} from '@moonshot-ai/agent-core';

import type { ModelAlias, ProviderConfig } from '../types';

export function catalogModelAlias(
  providerId: string,
  model: CatalogModel,
  info: CatalogProviderInfo | undefined,
): string {
  return `${info?.aliasScope ?? providerId}/${model.id}`;
}

export function capabilityList(capability: ModelCapability = {}): string[] {
  return [
    capability.image_in ? 'image_in' : undefined,
    capability.video_in ? 'video_in' : undefined,
    capability.audio_in ? 'audio_in' : undefined,
    capability.thinking ? 'thinking' : undefined,
    capability.tool_use ? 'tool_use' : undefined,
  ].filter((entry): entry is string => entry !== undefined);
}

export function catalogModelToAlias(model: CatalogModel): ModelAlias {
  return {
    provider: model.provider,
    model: model.name,
    baseUrl: model.endpoint?.baseUrl,
    maxContextSize: model.maxContextSize,
    maxOutputSize: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : undefined,
    capabilities: capabilityList(model.capability),
    displayName: model.displayName,
    reasoningKey:
      typeof model.protocolOptions?.['reasoningKey'] === 'string'
        ? (model.protocolOptions['reasoningKey'] as string)
        : undefined,
    protocol: model.protocol,
    adaptiveThinking: model.thinking?.adaptiveThinking,
    supportEfforts: model.thinking?.supportEfforts,
    defaultEffort: model.thinking?.defaultEffort,
    offEffort: model.thinking?.offEffort,
    alwaysThinking: model.thinking?.alwaysThinking,
  };
}

export function collectAvailableModels(catalog: ProviderCatalogFace): {
  readonly models: Record<string, ModelAlias>;
  readonly providers: Record<string, ProviderConfig>;
} {
  const models: Record<string, ModelAlias> = {};
  const providers: Record<string, ProviderConfig> = {};
  for (const providerId of catalog.providers()) {
    const info = catalog.providerInfo(providerId);
    providers[providerId] = { type: info?.type, baseUrl: info?.baseUrl, oauth: info?.oauth };
    for (const model of catalog.models(providerId)) {
      models[catalogModelAlias(providerId, model, info)] = catalogModelToAlias(model);
    }
  }
  return { models, providers };
}
