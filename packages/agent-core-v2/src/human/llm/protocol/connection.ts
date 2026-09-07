import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';

import type { ProtocolHookContext } from './context';

export interface ProtocolEndpoint {
  readonly apiKeyEnv?: string | readonly string[];
  readonly baseUrlEnv?: string | readonly string[];
  readonly defaultBaseUrl?: string;
}

export interface ProviderConnection {
  endpoint?(): ProtocolEndpoint | undefined;
  defaultHeaders?(ctx: ProtocolHookContext): Record<string, string> | undefined;
  convertError?(error: unknown, ctx: ProtocolHookContext): LlmRemoteErrorMessage | undefined;
}

function readEnv(envNames: string | readonly string[] | undefined): string | undefined {
  if (envNames === undefined) {
    return undefined;
  }
  const names = typeof envNames === 'string' ? [envNames] : envNames;
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function resolveModelConnection(
  model: LlmModel,
  connection: ProviderConnection | undefined,
): LlmModel {
  const declaration = connection?.endpoint?.();
  if (declaration === undefined) {
    return model;
  }
  return {
    ...model,
    baseUrl: model.baseUrl ?? readEnv(declaration.baseUrlEnv) ?? declaration.defaultBaseUrl,
    apiKey: model.apiKey ?? readEnv(declaration.apiKeyEnv),
  };
}
