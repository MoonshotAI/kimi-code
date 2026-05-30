import type { ModelInfo, SessionModelState } from '@agentclientprotocol/sdk';
import {
  log,
  type KimiConfig,
  type Session,
  type SessionStatus,
} from '@moonshot-ai/kimi-code-sdk';

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

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized !== undefined && normalized.length > 0) return normalized;
  }
  return undefined;
}
