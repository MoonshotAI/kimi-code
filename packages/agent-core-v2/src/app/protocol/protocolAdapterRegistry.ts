import type { ChatProvider, ProviderConfig as KosongProviderConfig } from '@moonshot-ai/kosong';
import { createProvider } from '@moonshot-ai/kosong';

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
 * factory. Delegates to `@moonshot-ai/kosong`'s `createProvider` for now;
 * this is v2's only runtime kosong boundary (Phase 8 replaces it with native
 * adapters). Bound at App scope.
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
    customHeaders: input.customHeaders as Record<string, string> | undefined,
    ...(input.extras ?? {}),
  };
  return base as KosongProviderConfig;
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  InstantiationType.Delayed,
  'protocol',
);
