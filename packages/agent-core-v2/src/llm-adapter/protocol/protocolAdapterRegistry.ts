import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '#human/llm/builtin/provider/index';
import type { OpenAIOptions } from '#human/llm/builtin/protocol/openai/index';
import { mergeHeaders } from '#human/llm/endpoint';
import type { LlmEndpoint, LlmSampling } from '#human/llm/request';
import { contentsOf, createRequester } from '#human/llm/requester';
import type { LlmRequester as CoreLlmRequester } from '#human/llm/requester';
import { isUnknownCapability } from '#human/llm-requester/capability';
import { resolveModelConnection } from '#human/llm-requester/connection';
import type { DefaultHeadersResolver, ProtocolEndpoint } from '#human/llm-requester/connection';
import type { LlmErrorClassifier } from '#human/llm-requester/requester';
import {
  anthropicEndpoint,
  geminiEndpoint,
  openAIEndpoint,
  vertexEndpoint,
} from '#human/llm-requester/endpoints';
import { createLlmHeadersTimeoutFetch } from '#human/llm-requester/timeout';
import type { LlmModel } from '#human/llm-requester/model';
import { modelKey } from '#human/llm-requester/model';
import { thinkingMetadataOf, type ModelThinkingMetadata } from '#human/llm-requester/thinking';

import { UNKNOWN_CAPABILITY, toLlmCapability, type ModelCapability } from '../contract/capability';
import type { Model } from '../model/catalog';
import type { InitializedLlmRequester, ModelRequestParams } from '../model/generate';
import { getProviderDefinition } from '../provider/provider-definition';

import { IProtocolAdapterRegistry, type Protocol } from './protocol';
import { getProtocolBase, listProtocolBases, type ProtocolBaseId } from './protocol-base';

interface AdapterRoute {
  readonly requester: CoreLlmRequester<'protocol'>;
  readonly options?: (params: ModelRequestParams | undefined) => unknown;
  readonly endpoint?: ProtocolEndpoint;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
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
        options: (params) => ({
          extras: samplingExtraParams('openai', params?.sampling),
          reasoningKey:
            definition?.requester === undefined ? openAIReasoningKeyFor(model) : undefined,
          toolMessageConversion:
            definition?.requester === undefined ? undefined : 'keep_parts',
        }),
        endpoint: definition?.endpoint ?? openAIEndpoint,
        defaultHeaders: definition?.defaultHeaders,
        classifyError: definition?.classifyError,
        providerId: 'openai',
      };
    case 'openai_responses':
      return {
        requester: definition?.requester ?? openAIResponsesRequester,
        options: (params) => ({
          extras: samplingExtraParams('openai_responses', params?.sampling),
        }),
        endpoint: definition?.endpoint ?? openAIEndpoint,
        defaultHeaders: definition?.defaultHeaders,
        classifyError: definition?.classifyError,
        providerId: 'openai-responses',
      };
    case 'anthropic': {
      const betaApi = model.providerOptions?.betaApi === true;
      return {
        requester: definition?.requester ?? anthropicRequester,
        options: (params) => ({
          betaApi,
          extras: samplingExtraParams('anthropic', params?.sampling),
        }),
        endpoint: definition?.endpoint ?? anthropicEndpoint,
        defaultHeaders: definition?.defaultHeaders,
        classifyError: definition?.classifyError,
        providerId: 'anthropic',
      };
    }
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            requester: googleVertexRequester,
            options: (params) => ({
              vertexai: true,
              extras: samplingExtraParams('google-genai', params?.sampling),
            }),
            endpoint: vertexEndpoint,
            providerId: 'google_genai',
          }
        : {
            requester: googleGenAIRequester,
            options: (params) => ({
              extras: samplingExtraParams('google-genai', params?.sampling),
            }),
            endpoint: geminiEndpoint,
            providerId: 'google_genai',
          };
  }
}

function samplingExtraParams(
  protocol: Protocol,
  sampling: LlmSampling | undefined,
): Record<string, unknown> | undefined {
  if (sampling === undefined) return undefined;
  const { temperature, topP } = sampling;
  if (temperature === undefined && topP === undefined) return undefined;
  switch (protocol) {
    case 'openai':
      return { temperature, top_p: topP };
    case 'openai_responses':
      return { temperature, top_p: topP };
    case 'anthropic':
      return { temperature, top_p: topP };
    case 'google-genai':
      return { temperature, topP };
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

  resolveCapability(protocol: Protocol, modelName: string, providerType?: string): ModelCapability {
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    const hooked = definition?.capability?.(modelName);
    if (hooked !== undefined) {
      return toV2Capability(hooked);
    }
    const baseCapability = getProtocolBase(identity.baseId)?.capability?.(modelName);
    if (baseCapability !== undefined) {
      return toV2Capability(baseCapability);
    }
    return UNKNOWN_CAPABILITY;
  }

  request(model: Model, params?: ModelRequestParams): InitializedLlmRequester {
    const route = routeFor(model);
    const llmModel: LlmModel & ModelThinkingMetadata = {
      provider: route.providerId,
      model: model.name,
      capability: toLlmCapability(model.capabilities),
      maxContextSize: model.maxContextSize > 0 ? model.maxContextSize : undefined,
      maxInputSize: model.maxInputSize,
      baseUrl: model.baseUrl,
      defaultHeaders: Object.keys(model.headers).length > 0 ? { ...model.headers } : undefined,
      supportEfforts: model.supportEfforts,
      defaultEffort: model.defaultEffort,
      offEffort: model.providerOptions?.offEffort,
      alwaysThinking: model.alwaysThinking,
      adaptiveThinking: model.providerOptions?.adaptiveThinking,
    };
    const connection = resolveModelConnection(llmModel, route.endpoint);
    const base = contentsOf(route.requester);
    const protocol = base.protocol;
    if (protocol?.base === undefined) throw new TypeError('requester protocol is not initialized');
    const protocolBase = protocol.base;
    let options = route.options?.(params);
    if (model.protocol === 'openai') {
      const resolved = options as OpenAIOptions | undefined;
      if (resolved?.reasoningKey === undefined) {
        const key = modelKey(connection);
        options = {
          ...resolved,
          detectedReasoningKey: this.detectedReasoningKeys.get(key),
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
      baseUrl: connection.baseUrl,
      headers: mergeHeaders(route.defaultHeaders?.({ model: connection }), connection.defaultHeaders),
      credentials: {
        resolve: async () => {
          const credential = await model.credentialProvider?.resolve();
          const apiKey = credential?.apiKey ?? connection.apiKey;
          if (credential === undefined && apiKey === undefined) return undefined;
          return { ...credential, apiKey };
        },
        canRecover: (error) => model.credentialProvider?.canRecover?.(error) === true,
        invalidate: () => model.credentialProvider?.invalidate?.(),
      },
      fetch:
        protocolBase.usesEndpointFetch === false
          ? undefined
          : (input, init) => createLlmHeadersTimeoutFetch()(input, init),
    };
    const contextSizes = [params?.maxContextTokens, connection.maxContextSize].filter(
      (size): size is number => size !== undefined && size > 0,
    );
    return createRequester().with({
      protocol: {
        ...protocol,
        base: Object.assign({}, protocolBase, {
          decodeError: (error: unknown) =>
            route.classifyError?.(error) ?? protocolBase.decodeError(error),
        }),
        options,
        stream: params?.stream ?? true,
      },
      endpoint,
      model: {
        spec: {
          provider: route.providerId,
          name: connection.model,
          capability: isUnknownCapability(connection.capability) ? undefined : connection.capability,
          thinking: thinkingMetadataOf(connection),
          maxContextSize: contextSizes.length === 0 ? undefined : Math.min(...contextSizes),
          maxInputSize: connection.maxInputSize,
        },
        thinking:
          params?.thinkingEffort === undefined
            ? undefined
            : { effort: params.thinkingEffort, keep: params.thinkingKeep },
        maxOutputTokens:
          params?.maxCompletionTokens === undefined
            ? undefined
            : params.maxCompletionTokens <= 0
              ? 'none'
              : params.maxCompletionTokens,
        cacheKey: params?.cacheKey,
        sampling: params?.sampling,
      },
    });
  }
}

function toV2Capability(capability: import('#human/llm/request').ModelCapability): ModelCapability {
  return {
    image_in: capability.image_in === true,
    video_in: capability.video_in === true,
    audio_in: capability.audio_in === true,
    thinking: capability.thinking === true,
    tool_use: capability.tool_use ?? true,
    max_context_tokens: 0,
    dynamically_loaded_tools: capability.dynamically_loaded_tools === true,
  };
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  ScopeActivation.OnScopeCreated,
  'provider',
);
