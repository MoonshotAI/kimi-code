import type { ChatProvider } from '#/app/llmProtocol/provider';
import { createProvider, type ProviderConfig as KosongProviderConfig } from '#/app/llmProtocol/providers/providers';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  IProtocolAdapterRegistry,
  type Protocol,
  type ProtocolAdapterConfig,
} from './protocol';


const SUPPORTED: readonly Protocol[] = [
  'kimi',
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
  'vertexai',
];

export class ProtocolAdapterRegistry
  extends Disposable
  implements IProtocolAdapterRegistry
{
  declare readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[] {
    return SUPPORTED;
  }

  createChatProvider(input: ProtocolAdapterConfig): ChatProvider {
    const kosongConfig = toKosongProviderConfig(input);
    return createProvider(kosongConfig);
  }
}

function toKosongProviderConfig(input: ProtocolAdapterConfig): KosongProviderConfig {
  const base = {
    type: input.protocol,
    model: input.modelName,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    defaultHeaders: input.defaultHeaders as Record<string, string> | undefined,
    ...definedOptions(input.providerOptions ?? {}),
  };
  return base as KosongProviderConfig;
}

function definedOptions(options: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  InstantiationType.Delayed,
  'protocol',
);
