import type { LlmModel } from '#/llm/model';

export interface ConnectionContext {
  readonly model: LlmModel;
}

export interface ProtocolEndpoint {
  readonly apiKeyEnv?: string;
  readonly baseUrlEnv?: string;
  readonly defaultBaseUrl?: string;
}

export interface ProviderConnection {
  endpoint?(ctx?: ConnectionContext): ProtocolEndpoint | undefined;

  defaultHeaders?(ctx: ConnectionContext): Record<string, string> | undefined;
}

export function resolveModelConnection(
  model: LlmModel,
  connection: ProviderConnection | undefined,
): LlmModel {
  const declaration = connection?.endpoint?.({ model });
  if (declaration === undefined) {
    return model;
  }
  const read = (envName: string | undefined): string | undefined => {
    if (envName === undefined) {
      return undefined;
    }
    const value = process.env[envName];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  return {
    ...model,
    baseUrl: model.baseUrl ?? read(declaration.baseUrlEnv) ?? declaration.defaultBaseUrl,
    apiKey: model.apiKey ?? read(declaration.apiKeyEnv),
  };
}
