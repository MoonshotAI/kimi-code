import { BugIndicatingError } from '#/_base/errors/errors';
import type { ModelCapability as HumanModelCapability } from '#human/llm/capability';
import type { ProtocolEndpoint, ProviderConnection } from '#human/llm/protocol/connection';
import type { ProtocolTraitMap } from '#human/llm/provider/definition';
import type { LlmErrorClassifier } from '#human/llm/requester/requester';
import {
  kimiAnthropicTrait,
  kimiConnection,
  kimiOpenAITrait,
  KIMI_DEFAULT_BASE_URL,
} from '#human/llm-kimi/trait';
import { classifyKimiQuotaError } from '#human/llm-kimi/errors';

import type { Protocol } from '../protocol/protocol';
import type { ModelSource } from './provider';

export const openAIConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' }),
};

export const anthropicConnection: ProviderConnection = {
  endpoint: () => ({ apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' }),
};

export const geminiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'GOOGLE_API_KEY',
  baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
};

export const vertexEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'VERTEXAI_API_KEY',
  baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL',
};

export const geminiConnection: ProviderConnection = {
  endpoint: () => geminiEndpoint,
};

export const vertexConnection: ProviderConnection = {
  endpoint: () => vertexEndpoint,
};

export const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: 'KIMI_API_KEY',
  baseUrlEnv: 'KIMI_BASE_URL',
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

export interface ProviderDefinition<N extends Protocol = Protocol> {
  readonly id: string;
  readonly baseProtocol: N;
  readonly trait?: ProtocolTraitMap[N];
  readonly connection?: ProviderConnection;
  readonly convertError?: LlmErrorClassifier;
  readonly capability?: (modelName: string) => HumanModelCapability | undefined;
  readonly endpoint?: ProtocolEndpoint;
  readonly endpoints?: readonly ProtocolEndpoint[];
  readonly hostHeaders?: 'full' | 'user-agent';
  readonly modelSource?: ModelSource;
}

const providerDefinitions = new Map<string, Map<Protocol, ProviderDefinition>>();

export function registerProviderDefinition<N extends Protocol>(
  definition: ProviderDefinition<N>,
): void {
  let byProtocol = providerDefinitions.get(definition.id);
  if (byProtocol === undefined) {
    byProtocol = new Map();
    providerDefinitions.set(definition.id, byProtocol);
  }
  if (byProtocol.has(definition.baseProtocol)) {
    throw new BugIndicatingError(
      `provider definition '${definition.id}' is already registered for protocol '${definition.baseProtocol}'`,
    );
  }
  byProtocol.set(definition.baseProtocol, definition);
}

export function getProviderDefinition(
  id: string,
  protocol?: Protocol,
): ProviderDefinition | undefined {
  const byProtocol = providerDefinitions.get(id);
  if (byProtocol === undefined) return undefined;
  if (protocol !== undefined) return byProtocol.get(protocol);
  return byProtocol.values().next().value;
}

export function getProviderDefinitions(id: string): readonly ProviderDefinition[] {
  const byProtocol = providerDefinitions.get(id);
  return byProtocol === undefined ? [] : [...byProtocol.values()];
}

export function hasProviderDefinition(id: string): boolean {
  return providerDefinitions.has(id);
}

export function isOAuthCatalogVendor(id: string | undefined): boolean {
  if (id === undefined) return false;
  return getProviderDefinitions(id).some(
    (definition) => definition.modelSource === 'oauth-catalog',
  );
}

export function listProviderDefinitions(): readonly ProviderDefinition[] {
  return [...providerDefinitions.values()].flatMap((byProtocol) => [...byProtocol.values()]);
}

export interface ResolvedProviderEndpoint {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface ExplainedProviderEndpoint {
  readonly apiKey?: string;
  readonly apiKeyEnvName?: string;
  readonly baseUrl?: string;
  readonly baseUrlEnvName?: string;
  readonly baseUrlIsDefault?: boolean;
}

export function explainProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExplainedProviderEndpoint {
  const definition = getProviderDefinition(providerType);
  if (definition === undefined) return {};
  const endpoint =
    normalizeEndpointDeclaration(definition.endpoint) ?? aggregateEndpoints(definition.endpoints);
  if (endpoint === undefined) return {};
  const apiKeyHit = firstEnvHit(endpoint.apiKeyEnv, env);
  const baseUrlHit = firstEnvHit(endpoint.baseUrlEnv, env);
  return {
    ...(apiKeyHit !== undefined
      ? { apiKey: apiKeyHit.value, apiKeyEnvName: apiKeyHit.name }
      : undefined),
    ...(baseUrlHit !== undefined
      ? { baseUrl: baseUrlHit.value, baseUrlEnvName: baseUrlHit.name }
      : endpoint.defaultBaseUrl !== undefined
        ? { baseUrl: endpoint.defaultBaseUrl, baseUrlIsDefault: true }
        : undefined),
  };
}

export function resolveProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedProviderEndpoint {
  const { apiKey, baseUrl } = explainProviderEndpoint(providerType, env);
  return {
    ...(apiKey !== undefined ? { apiKey } : undefined),
    ...(baseUrl !== undefined ? { baseUrl } : undefined),
  };
}

interface AggregatedEndpointDeclaration {
  readonly apiKeyEnv: readonly string[];
  readonly baseUrlEnv: readonly string[];
  readonly defaultBaseUrl?: string;
}

function normalizeEndpointDeclaration(
  endpoint: ProtocolEndpoint | undefined,
): AggregatedEndpointDeclaration | undefined {
  if (endpoint === undefined) return undefined;
  return {
    apiKeyEnv: endpoint.apiKeyEnv === undefined ? [] : [endpoint.apiKeyEnv],
    baseUrlEnv: endpoint.baseUrlEnv === undefined ? [] : [endpoint.baseUrlEnv],
    defaultBaseUrl: endpoint.defaultBaseUrl,
  };
}

function aggregateEndpoints(
  endpoints: readonly ProtocolEndpoint[] | undefined,
): AggregatedEndpointDeclaration | undefined {
  if (endpoints === undefined || endpoints.length === 0) return undefined;
  const apiKeyEnv: string[] = [];
  const baseUrlEnv: string[] = [];
  let defaultBaseUrl: string | undefined;
  for (const endpoint of endpoints) {
    if (endpoint.apiKeyEnv !== undefined) apiKeyEnv.push(endpoint.apiKeyEnv);
    if (endpoint.baseUrlEnv !== undefined) baseUrlEnv.push(endpoint.baseUrlEnv);
    if (endpoint.defaultBaseUrl !== undefined) defaultBaseUrl = endpoint.defaultBaseUrl;
  }
  return { apiKeyEnv, baseUrlEnv, defaultBaseUrl };
}

function firstEnvHit(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { readonly name: string; readonly value: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return { name, value };
  }
  return undefined;
}

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  endpoint: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  endpoints: [vertexEndpoint, geminiEndpoint],
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai',
  trait: kimiOpenAITrait,
  connection: kimiConnection,
  convertError: classifyKimiQuotaError,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  trait: kimiAnthropicTrait,
  connection: kimiConnection,
  convertError: classifyKimiQuotaError,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai_responses',
  connection: kimiConnection,
  convertError: classifyKimiQuotaError,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});
