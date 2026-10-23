import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY, toLlmCapability, type ModelCapability } from '../contract/capability';
import type { ModelThinkingMetadata } from '#human/llm/thinking';
import type { ProviderMediaContribution } from '#human/llm/media/upload';
import type { LlmModel } from '#human/llm/model';
import type { ProviderConnection } from '#human/llm/protocol/connection';
import type { LlmErrorClassifier, LlmRequester } from '#human/llm/requester/requester';
import { anthropicBase, anthropicBetaBase } from '#human/llm/requester/bases/anthropic/requester';
import {
  createGoogleGenAIBase,
  googleGenAIBase,
} from '#human/llm/requester/bases/google-genai/requester';
import { createOpenAIRequester } from '#human/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';
import { KimiFiles, kimiFilesBaseUrl } from '#human/llm-kimi/files';

import type { Model } from '../model/catalog';
import type { ResolvedLlmModel } from '../model/model-requester-impl';
import {
  anthropicConnection,
  geminiConnection,
  getProviderDefinition,
  openAIConnection,
  vertexConnection,
  type ProviderRequesterFactoryOptions,
} from '../provider/provider-definition';

import { IProtocolAdapterRegistry, type Protocol } from './protocol';
import { getProtocolBase, listProtocolBases, type ProtocolBaseId } from './protocol-base';

const vertexGenAIBase = createGoogleGenAIBase({ vertexai: true });

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
  readonly createRequester: (options: AdapterRequesterOptions) => LlmRequester;
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly providerId: string;
  readonly media?: ProviderMediaContribution;
}

interface AdapterRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
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
  const customFactory =
    definition !== undefined && definition.requester !== undefined
      ? (options: ProviderRequesterFactoryOptions) => definition.requester!(options)
      : undefined;
  switch (model.protocol) {
    case 'openai':
      return {
        createRequester:
          customFactory ??
          ((options) =>
            createOpenAIRequester({ ...options, reasoningKey: openAIReasoningKeyFor(model) })),
        connection: definition?.connection ?? openAIConnection,
        classifyError: definition?.classifyError,
        providerId: 'openai',
        media: routeMedia,
      };
    case 'openai_responses':
      return {
        createRequester: customFactory ?? ((options) => openAIResponsesBase.createRequester(options)),
        connection: definition?.connection ?? openAIConnection,
        classifyError: definition?.classifyError,
        providerId: 'openai-responses',
        media: routeMedia,
      };
    case 'anthropic': {
      const betaApi = model.providerOptions?.betaApi === true;
      const base = betaApi ? anthropicBetaBase : anthropicBase;
      return {
        createRequester:
          customFactory !== undefined
            ? (options) => customFactory({ ...options, betaApi: betaApi ? true : undefined })
            : (options) => base.createRequester(options),
        connection: definition?.connection ?? anthropicConnection,
        classifyError: definition?.classifyError,
        providerId: 'anthropic',
        media: routeMedia,
      };
    }
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            createRequester: (options) => vertexGenAIBase.createRequester(options),
            connection: vertexConnection,
            providerId: 'google_genai',
          }
        : {
            createRequester: (options) => googleGenAIBase.createRequester(options),
            connection: geminiConnection,
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
    const baseCapability = getProtocolBase(identity.baseId)?.base.capability?.(modelName);
    if (baseCapability !== undefined) {
      return toV2Capability(baseCapability);
    }
    return UNKNOWN_CAPABILITY;
  }

  resolve(model: Model): ResolvedLlmModel {
    const route = routeFor(model);
    const requester = route.createRequester({
      connection: route.connection,
      classifyError: route.classifyError,
    });
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

function toV2Capability(capability: import('#human/llm/capability').ModelCapability): ModelCapability {
  return {
    image_in: capability.image_in,
    video_in: capability.video_in,
    audio_in: capability.audio_in,
    thinking: capability.thinking,
    tool_use: capability.tool_use,
    max_context_tokens: 0,
    dynamically_loaded_tools: capability.dynamically_loaded_tools,
  };
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  ScopeActivation.OnScopeCreated,
  'provider',
);
