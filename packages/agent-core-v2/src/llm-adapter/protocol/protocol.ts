import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ModelCapability } from '../contract/capability';
import type { InspectionSource } from '../contract/inspection';
import type { Model } from '../model/catalog';
import type { ResolvedLlmModel } from '../model/model-requester-impl';

import type { ProtocolBaseId, ResolvedAdapterIdentity } from './protocol-base';

export const ProtocolSchema = z.enum(['anthropic', 'openai', 'openai_responses', 'google-genai']);

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

  resolve(model: Model): ResolvedLlmModel;
}

export const IProtocolAdapterRegistry: ServiceIdentifier<IProtocolAdapterRegistry> =
  createDecorator<IProtocolAdapterRegistry>('protocolAdapterRegistry');
