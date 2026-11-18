import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '@moonshot-ai/core/llm/builtin/provider/index';
import type { OpenAIOptions } from '@moonshot-ai/core/llm/builtin/protocol/openai/index';
import { modelKey, type LlmEndpoint, type ModelCapability } from '@moonshot-ai/core/llm/request';
import {
  contentsOf,
  createRequester,
  type InitializedLlmRequester,
  type InitializedLlmRequestPart,
  type LlmRequester as CoreLlmRequester,
} from '@moonshot-ai/core/llm/requester';
import { createLlmHeadersTimeoutFetch } from '@moonshot-ai/core/llm/transport/headers-timeout';
import {
  createLlmRequesterExecution,
  type LlmRequesterExecution,
} from '@moonshot-ai/core/llm/policy/policy';

import type { Model } from '../model/catalog';
import { getProviderDefinition } from '../provider/provider-definition';

import { IProtocolAdapterRegistry, type Protocol } from './protocol';
import { getProtocolBase, listProtocolBases, type ProtocolBaseId } from './protocol-base';

interface AdapterRoute {
  readonly requester: CoreLlmRequester<'protocol'>;
  readonly options?: unknown;
  readonly providerId: string;
}

function openAIReasoningKeyFor(model: Model): string | undefined {
  return model.providerOptions?.reasoningKey ?? model.reasoningKey;
}

function routeFor(model: Model): AdapterRoute {
  const definition =
    model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
  switch (model.protocol) {
    case 'openai':
      return {
        requester: definition?.requester ?? openAIRequester,
        options: {
          reasoningKey:
            definition?.requester === undefined ? openAIReasoningKeyFor(model) : undefined,
          toolMessageConversion: definition?.requester === undefined ? undefined : 'keep_parts',
        },
        providerId: 'openai',
      };
    case 'openai_responses':
      return {
        requester: definition?.requester ?? openAIResponsesRequester,
        providerId: 'openai-responses',
      };
    case 'anthropic':
      return {
        requester: definition?.requester ?? anthropicRequester,
        options: { betaApi: model.providerOptions?.betaApi === true },
        providerId: 'anthropic',
      };
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            requester: googleVertexRequester,
            options: { vertexai: true },
            providerId: 'google_genai',
          }
        : {
            requester: googleGenAIRequester,
            providerId: 'google_genai',
          };
  }
}

export class ProtocolAdapterRegistry implements IProtocolAdapterRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly detectedReasoningKeys = new Map<string, string>();

  supportedProtocols(): readonly Protocol[] {
    return listProtocolBases().map((base) => base.id);
  }

  resolveAdapterIdentity(protocol: Protocol, providerType?: string) {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    const baseId: ProtocolBaseId = definition?.baseProtocol ?? protocol;
    return {
      baseId,
      thinkingDriven: definition?.thinkingDriven,
      strictThinkingValidation: definition?.strictThinkingValidation,
    };
  }

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    return definition?.baseProtocol ?? protocol;
  }

  resolveCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ModelCapability | undefined {
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    return (
      definition?.capability?.(modelName) ??
      getProtocolBase(identity.baseId)?.capability?.(modelName)
    );
  }

  request(
    model: Model,
    part?: InitializedLlmRequestPart,
    execution: LlmRequesterExecution = createLlmRequesterExecution(),
  ): InitializedLlmRequester {
    const route = routeFor(model);
    const base = contentsOf(route.requester);
    const protocol = base.protocol;
    if (protocol?.base === undefined) throw new TypeError('requester protocol is not initialized');
    const protocolBase = protocol.base;
    let options = route.options;
    if (model.protocol === 'openai') {
      const resolved = options as OpenAIOptions | undefined;
      if (resolved?.reasoningKey === undefined) {
        const key = modelKey(model.spec, model.endpoint);
        options = {
          ...resolved,
          detectedReasoningKey: () => this.detectedReasoningKeys.get(key),
          onReasoningKey: (reasoningKey: string) => {
            if (!this.detectedReasoningKeys.has(key)) {
              this.detectedReasoningKeys.set(key, reasoningKey);
            }
          },
        };
      }
    }
    const endpoint: LlmEndpoint = {
      ...base.endpoint,
      ...model.endpoint,
      fetch:
        protocolBase.usesEndpointFetch === false
          ? undefined
          : (input, init) => createLlmHeadersTimeoutFetch()(input, init),
    };
    const initialized = createRequester(execution).with(route.requester).with({
      protocol: {
        options,
        stream: true,
        recoveryKey: JSON.stringify([
          model.protocol,
          model.providerType,
          route.providerId,
          model.providerOptions?.betaApi === true,
          model.providerOptions?.vertexai === true,
        ]),
      },
      endpoint,
      model: {
        spec: { ...model.spec, provider: route.providerId },
      },
    });
    const resolved = initialized.with(part ?? {});
    const spec = contentsOf(resolved).model?.spec;
    if (spec === undefined) throw new TypeError('requester model is not initialized');
    return resolved.with({ model: { spec: { ...spec, provider: route.providerId } } });
  }
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  ScopeActivation.OnScopeCreated,
  'provider',
);
