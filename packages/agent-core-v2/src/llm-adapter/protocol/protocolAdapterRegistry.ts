import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '#human/llm/builtin/provider/index';
import type { LlmRequester as CoreLlmRequester } from '#human/llm/requester';
import type { ProviderMediaContribution } from '#human/media/upload';
import type { LlmModel } from '#human/llm-requester/model';
import type { DefaultHeadersResolver, ProtocolEndpoint } from '#human/llm-requester/connection';
import {
  anthropicEndpoint,
  geminiEndpoint,
  openAIEndpoint,
  vertexEndpoint,
} from '#human/llm-requester/endpoints';
import type { LlmErrorClassifier, LlmRequestConfig } from '#human/llm-requester/requester';
import { createOpenAIRunRequester } from '#human/llm-requester/openai';
import { createRunRequester } from '#human/llm-requester/run';
import { KimiFiles, kimiFilesBaseUrl } from '#human/media/kimi/files';
import type { ModelThinkingMetadata } from '#human/llm-requester/thinking';

import { UNKNOWN_CAPABILITY, toLlmCapability, type ModelCapability } from '../contract/capability';
import type { Model } from '../model/catalog';
import type { ResolvedLlmModel } from '../model/model-requester-impl';
import { getProviderDefinition } from '../provider/provider-definition';

import { IProtocolAdapterRegistry, type Protocol } from './protocol';
import { getProtocolBase, listProtocolBases, type ProtocolBaseId } from './protocol-base';

const kimiMedia: ProviderMediaContribution = {
  uploadVideo: (video, { model, signal }) =>
    new KimiFiles({
      apiKey: model.apiKey,
      baseUrl: kimiFilesBaseUrl(model),
      defaultHeaders: model.defaultHeaders === undefined ? undefined : { ...model.defaultHeaders },
    }).uploadVideo(video, { signal }),
  uploadImage: (image, { model, signal }) =>
    new KimiFiles({
      apiKey: model.apiKey,
      baseUrl: kimiFilesBaseUrl(model),
      defaultHeaders: model.defaultHeaders === undefined ? undefined : { ...model.defaultHeaders },
    }).uploadImage(image, { signal }),
};

interface AdapterRoute {
  readonly requester: CoreLlmRequester<'protocol'>;
  readonly options?: (config: LlmRequestConfig) => unknown;
  readonly endpoint?: ProtocolEndpoint;
  readonly defaultHeaders?: DefaultHeadersResolver;
  readonly classifyError?: LlmErrorClassifier;
  readonly providerId: string;
  readonly media?: ProviderMediaContribution;
}

function openAIReasoningKeyFor(model: Model): string | undefined {
  return model.providerOptions?.reasoningKey ?? model.reasoningKey;
}

function routeFor(model: Model): AdapterRoute {
  const definition =
    model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
  const routeMedia = definition?.modelSource === 'oauth-catalog' ? kimiMedia : undefined;
  switch (model.protocol) {
    case 'openai':
      return {
        requester: definition?.requester ?? openAIRequester,
        options: (config) => ({
          extras: config.extraParams?.openai,
          reasoningKey:
            definition?.requester === undefined ? openAIReasoningKeyFor(model) : undefined,
          toolMessageConversion:
            definition?.requester === undefined
              ? config.toolMessageConversion
              : (config.toolMessageConversion ?? 'keep_parts'),
        }),
        endpoint: definition?.endpoint ?? openAIEndpoint,
        defaultHeaders: definition?.defaultHeaders,
        classifyError: definition?.classifyError,
        providerId: 'openai',
        media: routeMedia,
      };
    case 'openai_responses':
      return {
        requester: definition?.requester ?? openAIResponsesRequester,
        options: (config) => ({
          extras: config.extraParams?.responses,
          toolMessageConversion: config.toolMessageConversion,
        }),
        endpoint: definition?.endpoint ?? openAIEndpoint,
        defaultHeaders: definition?.defaultHeaders,
        classifyError: definition?.classifyError,
        providerId: 'openai-responses',
        media: routeMedia,
      };
    case 'anthropic': {
      const betaApi = model.providerOptions?.betaApi === true;
      return {
        requester: definition?.requester ?? anthropicRequester,
        options: (config) => ({
          betaApi: betaApi || config.model.betaApi === true,
          extras: config.extraParams?.anthropic,
        }),
        endpoint: definition?.endpoint ?? anthropicEndpoint,
        defaultHeaders: definition?.defaultHeaders,
        classifyError: definition?.classifyError,
        providerId: 'anthropic',
        media: routeMedia,
      };
    }
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            requester: googleVertexRequester,
            options: (config) => ({
              vertexai: config.model.vertexai === true ? true : undefined,
              extras: config.extraParams?.googleGenai,
            }),
            endpoint: vertexEndpoint,
            providerId: 'google_genai',
          }
        : {
            requester: googleGenAIRequester,
            options: (config) => ({
              vertexai: config.model.vertexai === true ? true : undefined,
              extras: config.extraParams?.googleGenai,
            }),
            endpoint: geminiEndpoint,
            providerId: 'google_genai',
          };
  }
}

export class ProtocolAdapterRegistry implements IProtocolAdapterRegistry {
  declare readonly _serviceBrand: undefined;

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

  resolve(model: Model): ResolvedLlmModel {
    const route = routeFor(model);
    const requesterOptions = {
      endpoint: route.endpoint,
      defaultHeaders: route.defaultHeaders,
      classifyError: route.classifyError,
      options: route.options,
    };
    const requester =
      model.protocol === 'openai'
        ? createOpenAIRunRequester(route.requester, requesterOptions)
        : createRunRequester(route.requester, requesterOptions);
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
    return { requester, protocol: model.protocol, model: llmModel, media: route.media };
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
