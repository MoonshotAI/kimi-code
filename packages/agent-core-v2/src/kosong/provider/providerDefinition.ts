/**
 * `kosong/provider` domain (L2) — the provider-definition registry.
 *
 * A `ProviderDefinition` is the declarative answer to "who is this vendor and
 * where do its key/url come from": the wire base it runs on natively, its
 * deviation traits (native transport and `dialects` slices for foreign
 * transports), its endpoint fallback chain, how much of the host's request
 * headers it receives, how its models are discovered, and its declared
 * capability. Registration happens exactly once per vendor, in the vendor's
 * `*.contrib.ts` side-effect module.
 *
 * `resolveProviderEndpoint` is the single authority on the endpoint fallback
 * chain: definition-level `endpoint` first, otherwise the aggregation of the
 * definition's trait endpoint hooks, resolved against a caller-supplied env
 * bag (defaulting to `process.env`).
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { Protocol, ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import type { ProtocolBaseId } from '#/kosong/protocol/protocolBase';
import type {
  ProtocolEndpoint,
  ProtocolTrait,
  TraitContext,
} from '#/kosong/protocol/protocolTrait';

import type { ModelSource } from './provider';

export interface ProviderDefinition {
  readonly id: string;
  /** The wire base this vendor runs on natively. */
  readonly base: ProtocolBaseId;
  /** Native-transport deviations, in composition order. */
  readonly traits: readonly ProtocolTrait[];
  /** Cross-transport deviations: the vendor × foreign-transport slices. */
  readonly dialects?: Partial<Record<Protocol, readonly ProtocolTrait[]>>;
  /** Definition-level endpoint declaration (alternative to trait hooks). */
  readonly endpoint?: ProtocolEndpoint;
  /**
   * How much of the host's request headers (UA/identity) this vendor
   * receives: `'full'` forwards them all, `'user-agent'` (the default)
   * forwards only the User-Agent.
   */
  readonly hostHeaders?: 'full' | 'user-agent';
  /** How the runtime should discover the vendor's models. */
  readonly modelSource?: ModelSource;
  /**
   * Declared capability. Resolution order is definition → traits → base:
   * when present this wins outright — even when it is `UNKNOWN_CAPABILITY`.
   */
  readonly capability?: ModelCapability;
}

const providerDefinitions = new Map<string, ProviderDefinition>();

/**
 * Register a provider definition. Called only from `*.contrib.ts` side-effect
 * modules at import time. Duplicate registration of the same id is a
 * programming error and throws — silently overwriting a vendor would make
 * composed providers depend on import order.
 */
export function registerProviderDefinition(definition: ProviderDefinition): void {
  if (providerDefinitions.has(definition.id)) {
    throw new Error(`provider definition '${definition.id}' is already registered`);
  }
  providerDefinitions.set(definition.id, definition);
}

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return providerDefinitions.get(id);
}

export function listProviderDefinitions(): readonly ProviderDefinition[] {
  return [...providerDefinitions.values()];
}

export interface ResolvedProviderEndpoint {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/**
 * Resolve a vendor's endpoint from its definition: the env fallback chain
 * declared at the definition level or aggregated from its traits, read from
 * `env` (a provider config's env bag, or `process.env` by default). Returns
 * `{}` for unregistered vendors and for definitions that declare no endpoint
 * at all.
 */
export function resolveProviderEndpoint(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedProviderEndpoint {
  const definition = getProviderDefinition(providerType);
  if (definition === undefined) return {};
  const endpoint =
    normalizeEndpointDeclaration(definition.endpoint) ?? aggregateTraitEndpoints(definition);
  if (endpoint === undefined) return {};
  const apiKey = firstEnvValue(endpoint.apiKeyEnv, env);
  const baseUrl = firstEnvValue(endpoint.baseUrlEnv, env) ?? endpoint.defaultBaseUrl;
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
  // Trait endpoint hooks receive a stub context: endpoint declarations are
  // static env-name/base-url declarations that never read the live config.
  const config: ProtocolAdapterConfig = {
    protocol: definition.base,
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

function firstEnvValue(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
