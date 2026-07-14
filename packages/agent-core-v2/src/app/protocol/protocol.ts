/**
 * `protocol` domain (L1) — wire protocol identifier and adapter registry.
 *
 * A Protocol names a wire encoding (Kimi native, Anthropic Messages, OpenAI
 * Chat Completions, OpenAI Responses API, Google GenAI, Vertex AI). Every
 * Model declares which Protocol it speaks; the resolver combines
 * (Protocol, Provider, Platform.auth) into a runnable god-object Model.
 *
 * `IProtocolAdapterRegistry` is the boundary v2 owns for "how do I create a
 * request handler that speaks this wire protocol". Its current implementation
 * delegates to `createProvider` from `llmProtocol/providers` (the kosong wire
 * source, kept flat under `llmProtocol`), which is v2's only runtime kosong
 * boundary (Phase 8 replaces this with native adapters).
 *
 * Bound at App scope; the registry is a pure, stateless singleton.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const ProtocolSchema = z.enum([
  'kimi',
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
  'vertexai',
]);

export type Protocol = z.infer<typeof ProtocolSchema>;

export interface ProtocolProviderOptions {
  readonly reasoningKey?: string;
  readonly defaultMaxTokens?: number;
  readonly adaptiveThinking?: boolean;
  readonly betaApi?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly supportEfforts?: readonly string[];
  readonly vertexai?: boolean;
  readonly project?: string;
  readonly location?: string;
}

export interface ProtocolAdapterConfig {
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly modelName: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface IProtocolAdapterRegistry {
  readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[];
}

export const IProtocolAdapterRegistry: ServiceIdentifier<IProtocolAdapterRegistry> =
  createDecorator<IProtocolAdapterRegistry>('protocolAdapterRegistry');
