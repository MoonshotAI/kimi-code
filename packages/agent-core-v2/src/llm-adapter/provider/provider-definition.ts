import { BugIndicatingError } from '#/_base/errors/errors';
import {
  resolveEndpointDeclaration,
  type LlmEndpointDeclaration,
  type ResolvedLlmEndpointDeclaration,
} from '@moonshot-ai/core/llm/endpoint';
import {
  anthropicEndpoint,
  bedrockEndpoint,
  geminiEndpoint,
  kimiEndpoint,
  openAIEndpoint,
  vertexEndpoint,
} from '@moonshot-ai/core/llm/builtin/provider/endpoints';
import { bedrockAnthropicRequester } from '@moonshot-ai/core/llm/builtin/provider/bedrock/anthropic';
import { bedrockModelCapability } from '@moonshot-ai/core/llm/builtin/provider/bedrock/routing';
import { kimiRequesters } from '@moonshot-ai/core/llm/builtin/provider/kimi/index';
import type { ModelCapability } from '@moonshot-ai/core/llm/request';
import type { LlmRequester } from '@moonshot-ai/core/llm/requester';

import type { Protocol } from '../protocol/protocol';
import type { ModelSource } from './provider';

export interface ProviderDefinition<N extends Protocol = Protocol> {
  readonly id: string;
  readonly baseProtocol: N;
  readonly requester?: LlmRequester<'protocol'>;
  readonly thinkingDriven?: boolean;
  readonly strictThinkingValidation?: boolean;
  readonly capability?: (modelName: string) => ModelCapability | undefined;
  readonly endpoint?: LlmEndpointDeclaration;
  readonly endpoints?: readonly LlmEndpointDeclaration[];
  readonly hostHeaders?: 'full' | 'user-agent';
  readonly requestMetadata?: boolean;
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

export type ExplainedProviderEndpoint = ResolvedLlmEndpointDeclaration;

export function explainProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  protocol?: Protocol,
): ExplainedProviderEndpoint {
  const definition =
    getProviderDefinition(providerType, protocol) ??
    (protocol === undefined ? undefined : getProviderDefinition(providerType));
  return resolveEndpointDeclaration(definition?.endpoint ?? definition?.endpoints, env);
}

export function resolveProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedProviderEndpoint {
  const { apiKey, baseUrl } = explainProviderEndpoint(providerType, env);
  return { apiKey, baseUrl };
}

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  endpoint: anthropicEndpoint,
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  endpoint: openAIEndpoint,
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  endpoint: openAIEndpoint,
});

registerProviderDefinition({
  id: 'bedrock',
  baseProtocol: 'openai',
  endpoint: bedrockEndpoint,
  capability: bedrockModelCapability,
});

registerProviderDefinition({
  id: 'bedrock',
  baseProtocol: 'openai_responses',
  endpoint: bedrockEndpoint,
  capability: bedrockModelCapability,
});

registerProviderDefinition({
  id: 'bedrock',
  baseProtocol: 'anthropic',
  requester: bedrockAnthropicRequester,
  endpoint: bedrockEndpoint,
  capability: bedrockModelCapability,
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  endpoints: [vertexEndpoint, geminiEndpoint],
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai',
  requester: kimiRequesters.openai,
  thinkingDriven: true,
  strictThinkingValidation: true,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  requestMetadata: true,
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  requester: kimiRequesters.anthropic,
  thinkingDriven: true,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  requestMetadata: true,
  modelSource: 'oauth-catalog',
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai_responses',
  requester: kimiRequesters.openai_responses,
  thinkingDriven: true,
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  requestMetadata: true,
  modelSource: 'oauth-catalog',
});
