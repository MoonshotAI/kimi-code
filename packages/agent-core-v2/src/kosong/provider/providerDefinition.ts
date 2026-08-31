import { BugIndicatingError } from '#/_base/errors/errors';
import type { Protocol, ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import type {
  ProtocolEndpoint,
  ProtocolTrait,
  TraitContext,
} from '#/kosong/protocol/protocolTrait';

import type { ModelSource } from './provider';

export interface ProviderDefinition {
  readonly id: string;
  readonly baseProtocol: Protocol;
  readonly traits: readonly ProtocolTrait[];
  readonly endpoint?: ProtocolEndpoint;
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
  const endpoint =
    normalizeEndpointDeclaration(definition.endpoint) ?? aggregateTraitEndpoints(definition);
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

function aggregateTraitEndpoints(
  definition: ProviderDefinition,
): AggregatedEndpointDeclaration | undefined {
  const config: ProtocolAdapterConfig = {
    protocol: definition.baseProtocol,
    providerType: definition.id,
    modelName: '',
  };
  const context: TraitContext = { config, providerId: definition.id };
  const apiKeyEnv: string[] = [];
  const baseUrlEnv: string[] = [];
  let defaultBaseUrl: string | undefined;
  let declared = false;
  for (const trait of definition.traits) {
    if (trait.endpoint === undefined) continue;
    const endpoint = trait.endpoint(context);
    if (endpoint === undefined) continue;
    declared = true;
    if (endpoint.apiKeyEnv !== undefined) apiKeyEnv.push(endpoint.apiKeyEnv);
    if (endpoint.baseUrlEnv !== undefined) baseUrlEnv.push(endpoint.baseUrlEnv);
    if (endpoint.defaultBaseUrl !== undefined) defaultBaseUrl = endpoint.defaultBaseUrl;
  }
  return declared ? { apiKeyEnv, baseUrlEnv, defaultBaseUrl } : undefined;
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
