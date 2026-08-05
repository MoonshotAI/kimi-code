/**
 * `kosong/protocol` domain — wire protocol identity and the adapter
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
 * Bound at App scope.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { InspectionSource } from '#/kosong/contract/inspection';
import type { ChatProvider } from '#/kosong/contract/provider';

import type { ProtocolBaseId, ResolvedAdapterIdentity } from './protocolBase';

export const ProtocolSchema = z.enum([
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
]);

export type Protocol = z.infer<typeof ProtocolSchema>;

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
  readonly providerType?: string;
  readonly baseUrl?: string;
  readonly modelName: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface ExplainedCapability {
  readonly capability: ModelCapability;
  readonly source: InspectionSource;
}

export interface IProtocolAdapterRegistry {
  readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[];

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity;

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId;

  resolveCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ModelCapability;

  explainCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ExplainedCapability;

  createChatProvider(config: ProtocolAdapterConfig): ChatProvider;
}

export const IProtocolAdapterRegistry: ServiceIdentifier<IProtocolAdapterRegistry> =
  createDecorator<IProtocolAdapterRegistry>('protocolAdapterRegistry');
