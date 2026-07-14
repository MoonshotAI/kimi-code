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

/**
 * `protocol` domain (L1) — `IProtocolAdapterRegistry` implementation.
 *
 * Owns the current mapping from a Protocol identifier to a request-handler
 * factory. Delegates to `createProvider` from `llmProtocol/providers` (the
 * kosong wire source, kept flat under `llmProtocol`); this is v2's only
 * runtime kosong boundary
 * (Phase 8 replaces it with native adapters). Bound at App scope.
 */

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

  /**
   * Package-internal: create a kosong-shaped `ChatProvider` from the
   * wire-agnostic config. Exposed as a plain method (not part of the public
   * contract) so `IModelResolver` can build a Model god object from it while
   * the public `ChatProvider` type remains internal to v2.
   */
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
  InstantiationType.Eager,
  'protocol',
);
