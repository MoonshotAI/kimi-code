import type {
  ModelInfo,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionModelState,
} from '@agentclientprotocol/sdk';
import {
  log,
  type KimiConfig,
  type Session,
  type SessionStatus,
} from '@moonshot-ai/kimi-code-sdk';

export const MODEL_CONFIG_OPTION_ID = 'model';

export async function createAcpModelState(
  config: KimiConfig,
  session: Session,
): Promise<SessionModelState | undefined> {
  const availableModels = availableModelsFromConfig(config);
  const status = await session.getStatus().catch((error: unknown): SessionStatus | undefined => {
    log.warn('acp model status read failed', { sessionId: session.id, error });
    return undefined;
  });
  const currentModelId = firstNonEmpty([
    status?.model,
    config.defaultModel,
    availableModels[0]?.modelId,
  ]);

  if (currentModelId === undefined) return undefined;
  const models = availableModels.some((model) => model.modelId === currentModelId)
    ? availableModels
    : [
        ...availableModels,
        {
          modelId: currentModelId,
          name: currentModelId,
          description: 'Current session model',
        },
      ];

  return {
    availableModels: models,
    currentModelId,
  };
}

export function createAcpModelConfigOptions(
  modelState: SessionModelState | undefined,
): SessionConfigOption[] {
  if (modelState === undefined) return [];

  return [
    {
      id: MODEL_CONFIG_OPTION_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelState.currentModelId,
      options: modelState.availableModels.map(modelConfigOptionFromInfo),
    },
  ];
}

function availableModelsFromConfig(config: KimiConfig): ModelInfo[] {
  return Object.entries(config.models ?? {}).map(([modelId, alias]) => ({
    modelId,
    name: firstNonEmpty([alias.displayName, modelId]) ?? modelId,
    description: modelDescription(alias.provider, alias.model, alias.maxContextSize),
  }));
}

function modelDescription(
  provider: string,
  model: string,
  maxContextSize: number,
): string {
  return `${provider}/${model} (${String(maxContextSize)} context)`;
}

function modelConfigOptionFromInfo(model: ModelInfo): SessionConfigSelectOption {
  const option: SessionConfigSelectOption = {
    value: model.modelId,
    name: model.name,
  };
  if (model.description !== undefined && model.description !== null) {
    option.description = model.description;
  }
  return option;
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized !== undefined && normalized.length > 0) return normalized;
  }
  return undefined;
}
