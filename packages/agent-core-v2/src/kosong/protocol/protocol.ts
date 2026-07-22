/**
 * `kosong/protocol` domain (L1) — wire protocol identity and the adapter
 * registry contract.
 *
 * A Protocol names a real wire encoding. There are exactly four: every
 * vendor-specific behavior that used to pose as a protocol is now expressed
 * as per-transport provider definitions (a base protocol plus declarative
 * traits) registered with the L2 provider domain, so this enum can never
 * grow a vendor entry again. (Vertex AI used to be the fifth entry; it is a
 * mode of the `google-genai` base now, enabled through
 * `ProtocolProviderOptions` — same wire encoding, different SDK client
 * options.)
 *
 * `IProtocolAdapterRegistry` is the single resolution point for
 * "(protocol, providerType) → which base + which traits" and the single
 * construction point for composed ChatProviders. The interface speaks only
 * L0/L1 types: vendor knowledge (the L2 definition registry) stays in L2 and
 * reaches this layer only as resolved, context-bound traits (`ResolvedTrait`).
 *
 * Bound at App scope; the production implementation lives in L2
 * (`kosong/provider/protocolAdapterRegistry`).
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { InspectionSource } from '#/kosong/contract/inspection';
import type { ChatProvider } from '#/kosong/contract/provider';

import type { ProtocolBaseId, ResolvedAdapterIdentity } from './protocolBase';

/**
 * The four real wire formats. Vendor names are deliberately absent: a vendor
 * is a set of `(baseProtocol, traits)` registrations, not a protocol.
 * `supportedProtocols()` is derived from the registered bases, so this enum
 * is the ceiling, not the roster.
 */
export const ProtocolSchema = z.enum([
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
]);

export type Protocol = z.infer<typeof ProtocolSchema>;

/**
 * Construction knobs carried by adapter configuration. Vendor-specific
 * request shaping does NOT live here (no vendor-thinking-style flags): those
 * differences are trait hooks. What remains are knobs the bases themselves
 * understand. The `vertexai` / `project` / `location` trio is how Vertex AI
 * is reached now that it is no longer a protocol: `vertexai: true` switches
 * the google-genai base's SDK client into vertex (ADC) mode.
 */
export interface ProtocolProviderOptions {
  readonly reasoningKey?: string;
  readonly defaultMaxTokens?: number;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly adaptiveThinking?: boolean;
  readonly betaApi?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly vertexai?: boolean;
  readonly project?: string;
  readonly location?: string;
}

export interface ProtocolAdapterConfig {
  readonly protocol: Protocol;
  /**
   * Free-form vendor identity (e.g. the `provider` field of a model record).
   * Deliberately not enumerated at parse time — validation happens at
   * resolve time against the L2 definition registry, which is what allows
   * external packages to register new vendors.
   */
  readonly providerType?: string;
  readonly baseUrl?: string;
  readonly modelName: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly providerOptions?: ProtocolProviderOptions;
}

/** The capability answer plus which level of the fallback chain produced it. */
export interface ExplainedCapability {
  readonly capability: ModelCapability;
  readonly source: InspectionSource;
}

export interface IProtocolAdapterRegistry {
  readonly _serviceBrand: undefined;

  /**
   * The wire protocols with a registered base, derived dynamically from the
   * base registry. Vendor definitions never appear here — a vendor is not a
   * protocol.
   */
  supportedProtocols(): readonly Protocol[];

  /**
   * The one resolution of "which base + which traits serve this
   * (protocol, providerType) pair". A `(providerType, protocol)` pair
   * registration contributes its traits; anything else — an unregistered
   * vendor (fully compatible vendors need no definition), no providerType,
   * or a vendor that simply does not run over this protocol — contributes
   * nothing and the protocol itself serves as the base. The returned traits
   * are context-bound (`ResolvedTrait`) and include the trailing synthetic
   * trait that lets config `defaultHeaders` win.
   */
  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity;

  /**
   * The base component of `resolveAdapterIdentity` without materializing
   * traits: the pair registration's `baseProtocol` when one is registered —
   * which IS the protocol by construction — otherwise the protocol itself.
   * Kept on the interface for stability; today the answer is always the
   * protocol.
   */
  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId;

  /**
   * Capability resolution with the fixed fallback chain: pair definition's
   * declared capability → trait `capability` hooks (last declarer wins) →
   * the base's own catalog. `UNKNOWN_CAPABILITY` when nothing knows the
   * model.
   */
  resolveCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ModelCapability;

  /**
   * The provenance-preserving twin of `resolveCapability` — the same chain,
   * but reports which level answered (definition / trait / base / none), so
   * inspection views can attribute a detected capability instead of just
   * serving it.
   */
  explainCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ExplainedCapability;

  /**
   * Resolve (protocol, providerType) from `config` and construct the
   * composed, immutable ChatProvider. The only way production code obtains
   * a wire adapter; composition (endpoint aggregation, hook composition)
   * happens inside the base's contrib factory at creation time.
   */
  createChatProvider(config: ProtocolAdapterConfig): ChatProvider;
}

export const IProtocolAdapterRegistry: ServiceIdentifier<IProtocolAdapterRegistry> =
  createDecorator<IProtocolAdapterRegistry>('protocolAdapterRegistry');
