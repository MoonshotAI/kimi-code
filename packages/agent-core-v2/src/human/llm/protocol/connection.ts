import { randomUUID } from 'node:crypto';

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

const OPENCODE_SESSION_HEADER = 'x-opencode-session';
const opencodeSessionIds = new Map<string, string>();

export function withOpencodeSessionHeader(
  baseUrl: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (baseUrl === undefined) {
    return headers;
  }
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return headers;
  }
  if (hostname !== 'opencode.ai' && !hostname.endsWith('.opencode.ai')) {
    return headers;
  }
  if (headers !== undefined && OPENCODE_SESSION_HEADER in headers) {
    return headers;
  }
  let sessionId = opencodeSessionIds.get(hostname);
  if (sessionId === undefined) {
    sessionId = randomUUID();
    opencodeSessionIds.set(hostname, sessionId);
  }
  return { ...headers, [OPENCODE_SESSION_HEADER]: sessionId };
}
