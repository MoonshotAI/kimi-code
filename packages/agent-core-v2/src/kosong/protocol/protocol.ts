/**
 * `kosong/protocol` domain (L1) — wire protocol identity and the adapter
 * registry contract.
 *
 * A Protocol names a real wire encoding. There are exactly five: every
 * vendor-specific behavior that used to pose as a protocol is now expressed
 * as a provider definition (a base plus declarative traits) registered with
 * the L2 provider domain, so this enum can never grow a vendor entry again.
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
import type { ChatProvider } from '#/kosong/contract/provider';

import type { ProtocolBaseId, ResolvedAdapterIdentity } from './protocolBase';

/**
 * The five real wire formats. Vendor names are deliberately absent: a vendor
 * is `{ base, traits }`, not a protocol. `supportedProtocols()` is derived
 * from the registered bases, so this enum is the ceiling, not the roster.
 */
export const ProtocolSchema = z.enum([
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
  'vertexai',
]);

export type Protocol = z.infer<typeof ProtocolSchema>;

/**
 * Construction knobs carried by adapter configuration. Vendor-specific
 * request shaping does NOT live here (no vendor-thinking-style flags): those
 * differences are trait hooks. What remains are knobs the bases themselves
 * understand.
 */
export interface ProtocolProviderOptions {
  readonly reasoningKey?: string;
  readonly defaultMaxTokens?: number;
  readonly supportEfforts?: readonly string[];
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
   * (protocol, providerType) pair". A vendor definition contributes its
   * native traits when the protocol matches its base, its `dialects` slice
   * when running over a foreign transport, and nothing when the vendor is
   * unregistered (fully compatible vendors need no definition). The returned
   * traits are context-bound (`ResolvedTrait`) and include the trailing
   * synthetic trait that lets config `defaultHeaders` win.
   */
  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity;

  /**
   * The base component of `resolveAdapterIdentity` without materializing
   * traits: the vendor definition's base when one is registered and matches
   * the protocol, otherwise the protocol itself.
   */
  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId;

  /**
   * Capability resolution with the fixed fallback chain: vendor definition's
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
   * Resolve (protocol, providerType) from `config` and construct the
   * composed, immutable ChatProvider. The only way production code obtains
   * a wire adapter; composition (endpoint aggregation, hook composition)
   * happens inside the base's contrib factory at creation time.
   */
  createChatProvider(config: ProtocolAdapterConfig): ChatProvider;
}

export const IProtocolAdapterRegistry: ServiceIdentifier<IProtocolAdapterRegistry> =
  createDecorator<IProtocolAdapterRegistry>('protocolAdapterRegistry');
