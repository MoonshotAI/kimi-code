import type { LlmModel } from '#/llm-requester/model';

export interface ConnectionContext {
  readonly model: LlmModel;
}

export interface ProtocolEndpoint {
  readonly apiKeyEnv?: string;
  readonly baseUrlEnv?: string;
  readonly defaultBaseUrl?: string;
}

export type ProtocolEndpointResolver = (
  ctx?: ConnectionContext,
) => ProtocolEndpoint | undefined;

export type ProtocolEndpointSource = ProtocolEndpoint | ProtocolEndpointResolver;

export type DefaultHeadersResolver = (
  ctx: ConnectionContext,
) => Record<string, string> | undefined;

export function resolveModelConnection(
  model: LlmModel,
  endpoint: ProtocolEndpointSource | undefined,
): LlmModel {
  const declaration = typeof endpoint === 'function' ? endpoint({ model }) : endpoint;
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
