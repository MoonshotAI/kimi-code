/**
 * `kosong/provider` domain (L2) — the provider-definition registry.
 *
 * A `ProviderDefinition` is the declarative answer to "who is this vendor and
 * where do its key/url come from": the protocol base this registration
 * composes with, its deviation traits (applying to that protocol only), its
 * endpoint fallback chain, how much of the host's request headers it
 * receives, how its models are discovered, and its declared capability.
 * Registration happens once per vendor × protocol pair, in the vendor's
 * `*.contrib.ts` side-effect module: a vendor running over several
 * transports registers one definition per protocol (Kimi composes with
 * `openai` on its native transport and registers a second definition over
 * `anthropic`). Vendor-level facts (endpoint, host headers, model source,
 * capability) are declared identically on every registration of the same id
 * via shared constants, so id-level queries can read any of them.
 *
 * `resolveProviderEndpoint` is the single authority on the endpoint fallback
 * chain: definition-level `endpoint` first, otherwise the aggregation of the
 * definition's trait endpoint hooks, resolved against a caller-supplied env
 * bag (defaulting to `process.env`).
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { Protocol, ProtocolAdapterConfig } from '#/kosong/protocol/protocol';
import type {
  ProtocolEndpoint,
  ProtocolTrait,
  TraitContext,
} from '#/kosong/protocol/protocolTrait';

import type { ModelSource } from './provider';

export interface ProviderDefinition {
  readonly id: string;
  /**
   * The protocol base this registration composes with; the traits apply to
   * this protocol only.
   */
  readonly baseProtocol: Protocol;
  /** Deviations from the base, in composition order. */
  readonly traits: readonly ProtocolTrait[];
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

const providerDefinitions = new Map<string, Map<Protocol, ProviderDefinition>>();

/**
 * Register a provider definition. Called only from `*.contrib.ts` side-effect
 * modules at import time. The same vendor id may register once per protocol;
 * duplicate registration of the same `(id, baseProtocol)` pair is a
 * programming error and throws — silently overwriting a registration would
 * make composed providers depend on import order.
 */
export function registerProviderDefinition(definition: ProviderDefinition): void {
  let byProtocol = providerDefinitions.get(definition.id);
  if (byProtocol === undefined) {
    byProtocol = new Map();
    providerDefinitions.set(definition.id, byProtocol);
  }
  if (byProtocol.has(definition.baseProtocol)) {
    throw new Error(
      `provider definition '${definition.id}' is already registered for protocol '${definition.baseProtocol}'`,
    );
  }
  byProtocol.set(definition.baseProtocol, definition);
}

/**
 * Pair-level exact lookup when `protocol` is given; the id-level
 * (vendor-level) view when it is not — the vendor's first registration.
 * Vendor-level facts are declared identically on every registration of the
 * same id (see the module header), so any registration answers an id-level
 * query.
 */
export function getProviderDefinition(
  id: string,
  protocol?: Protocol,
): ProviderDefinition | undefined {
  const byProtocol = providerDefinitions.get(id);
  if (byProtocol === undefined) return undefined;
  if (protocol !== undefined) return byProtocol.get(protocol);
  return byProtocol.values().next().value;
}

/** Every registration of one vendor id, in registration order. */
export function getProviderDefinitions(id: string): readonly ProviderDefinition[] {
  const byProtocol = providerDefinitions.get(id);
  return byProtocol === undefined ? [] : [...byProtocol.values()];
}

export function hasProviderDefinition(id: string): boolean {
  return providerDefinitions.has(id);
}

/**
 * Whether any registration of the vendor declares `modelSource:
 * 'oauth-catalog'` — the registry answer to "is this vendor backed by the
 * managed OAuth model catalog", so callers never compare the vendor id
 * string.
 */
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
  /** The env-bag name that supplied the apiKey (absent when it did not). */
  readonly apiKeyEnvName?: string;
  readonly baseUrl?: string;
  /** The env-bag name that supplied the baseUrl (absent when it did not). */
  readonly baseUrlEnvName?: string;
  /** True when the baseUrl is the definition's `defaultBaseUrl`, not env. */
  readonly baseUrlIsDefault?: boolean;
}

/**
 * The provenance-preserving twin of `resolveProviderEndpoint` — same chain,
 * but reports WHICH env-bag name supplied each value (and whether the baseUrl
 * is the definition's built-in default), so inspection views can attribute
 * endpoints without re-walking the declaration.
 */
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

/**
 * Resolve a vendor's endpoint from its definition: the env fallback chain
 * declared at the definition level or aggregated from its traits, read from
 * `env` (a provider config's env bag, or `process.env` by default). This is
 * an id-level query — the endpoint is a vendor-level fact, declared
 * identically on each of the vendor's registrations. Returns `{}` for
 * unregistered vendors and for definitions that declare no endpoint at all.
 */
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
  // Trait endpoint hooks receive a stub context: endpoint declarations are
  // static env-name/base-url declarations that never read the live config.
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
