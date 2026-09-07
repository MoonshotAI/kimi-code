import { BugIndicatingError } from '#/_base/errors/errors';
import type { ProviderConnection } from '#human/llm/protocol/connection';
import type { ProtocolDialect } from '#human/llm/protocol/dialect';
import type { ModelPolicy } from '#human/llm/protocol/policy';
import {
  anthropicConnection,
  openAIConnection,
} from '#human/llm/provider/providers/standard';
import { kimiConnection } from '#human/llm-kimi/connection';
import {
  kimiAnthropicPolicy,
  kimiOpenAIDialect,
  kimiOpenAIPolicy,
} from '#human/llm-kimi/wiring';

import type { Protocol } from '../protocol/protocol';
import type { ModelSource } from './provider';

export const googleConnection: ProviderConnection = {
  endpoint: () => ({
    apiKeyEnv: ['VERTEXAI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrlEnv: ['GOOGLE_VERTEX_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
  }),
};

export interface ProviderDefinition {
  readonly id: string;
  readonly baseProtocol: Protocol;
  readonly connection?: ProviderConnection;
  readonly dialect?: ProtocolDialect;
  readonly policy?: ModelPolicy;
  readonly hostHeaders?: 'full' | 'user-agent';
  readonly modelSource?: ModelSource;
}

const providerDefinitions = new Map<string, Map<Protocol, ProviderDefinition>>();

export function registerProviderDefinition(definition: ProviderDefinition): void {
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
  const endpoint = definition.connection?.endpoint?.();
  if (endpoint === undefined) return {};
  const apiKeyHit = firstEnvHit(envNames(endpoint.apiKeyEnv), env);
  const baseUrlHit = firstEnvHit(envNames(endpoint.baseUrlEnv), env);
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

function envNames(names: string | readonly string[] | undefined): readonly string[] {
  if (names === undefined) return [];
  return typeof names === 'string' ? [names] : names;
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
  connection: anthropicConnection,
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  connection: openAIConnection,
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  connection: openAIConnection,
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  connection: googleConnection,
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai',
  connection: kimiConnection,
  dialect: kimiOpenAIDialect,
  policy: kimiOpenAIPolicy,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  connection: kimiConnection,
  policy: kimiAnthropicPolicy,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai_responses',
  connection: kimiConnection,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
});
