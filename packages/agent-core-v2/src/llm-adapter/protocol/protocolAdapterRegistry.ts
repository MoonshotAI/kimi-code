import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY, toLlmCapability, type ModelCapability } from '../contract/capability';
import type { ModelThinkingMetadata } from '#human/llm/thinking';
import type { ProviderMediaContribution } from '#human/llm/media/upload';
import type { LlmModel } from '#human/llm/model';
import type { ProtocolBase } from '#human/llm/protocol/base';
import type { ProviderConnection } from '#human/llm/protocol/connection';
import type { AnyProtocolTrait } from '#human/llm/provider/definition';
import type { LlmErrorClassifier } from '#human/llm/requester/requester';
import { anthropicBase, anthropicBetaBase } from '#human/llm/requester/bases/anthropic/requester';
import {
  createGoogleGenAIBase,
  googleGenAIBase,
} from '#human/llm/requester/bases/google-genai/requester';
import type { OpenAITrait } from '#human/llm/requester/bases/openai/trait';
import { openAIBase } from '#human/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';
import { KimiFiles } from '#human/llm-kimi/files';
import { KIMI_DEFAULT_BASE_URL } from '#human/llm-kimi/trait';

import type { Model } from '../model/catalog';
import type { ResolvedLlmModel } from '../model/model-requester-impl';
import {
  anthropicConnection,
  geminiConnection,
  getProviderDefinition,
  openAIConnection,
  vertexConnection,
} from '../provider/provider-definition';

import { IProtocolAdapterRegistry, type Protocol } from './protocol';
import { getProtocolBase, listProtocolBases, type ProtocolBaseId } from './protocol-base';

const vertexGenAIBase = createGoogleGenAIBase({ vertexai: true });

const kimiMedia: ProviderMediaContribution = {
  uploadVideo: (video, { model, signal }) =>
    new KimiFiles({
      apiKey: model.apiKey,
      baseUrl: model.baseUrl ?? KIMI_DEFAULT_BASE_URL,
      defaultHeaders: model.defaultHeaders === undefined ? undefined : { ...model.defaultHeaders },
    }).uploadVideo(video, { signal }),
};

interface AdapterRoute {
  readonly base: ProtocolBase<AnyProtocolTrait>;
  readonly trait?: AnyProtocolTrait;
  readonly connection?: ProviderConnection;
  readonly convertError?: LlmErrorClassifier;
  readonly providerId: string;
  readonly media?: ProviderMediaContribution;
}

function openAIReasoningTraitFor(model: Model): OpenAITrait | undefined {
  const reasoningKey = model.providerOptions?.reasoningKey ?? model.reasoningKey;
  return reasoningKey === undefined ? undefined : { reasoningKey };
}

function routeFor(model: Model): AdapterRoute {
  const definition =
    model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
  const routeMedia = definition?.modelSource === 'oauth-catalog' ? kimiMedia : undefined;
  const custom =
    definition !== undefined &&
    (definition.trait !== undefined ||
      definition.connection !== undefined ||
      definition.convertError !== undefined)
      ? definition
      : undefined;
  switch (model.protocol) {
    case 'openai':
      return custom !== undefined
        ? {
            base: openAIBase,
            trait: custom.trait,
            connection: custom.connection,
            convertError: custom.convertError,
            providerId: 'openai',
            media: routeMedia,
          }
        : {
            base: openAIBase,
            trait: openAIReasoningTraitFor(model),
            connection: openAIConnection,
            providerId: 'openai',
          };
    case 'openai_responses':
      return custom !== undefined
        ? {
            base: openAIResponsesBase,
            trait: custom.trait,
            connection: custom.connection,
            convertError: custom.convertError,
            providerId: 'openai-responses',
            media: routeMedia,
          }
        : {
            base: openAIResponsesBase,
            connection: openAIConnection,
            providerId: 'openai-responses',
          };
    case 'anthropic': {
      const base = model.providerOptions?.betaApi === true ? anthropicBetaBase : anthropicBase;
      return custom !== undefined
        ? {
            base,
            trait: custom.trait,
            connection: custom.connection,
            convertError: custom.convertError,
            providerId: 'anthropic',
            media: routeMedia,
          }
        : { base, connection: anthropicConnection, providerId: 'anthropic' };
    }
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            base: vertexGenAIBase,
            connection: vertexConnection,
            providerId: 'google_genai',
          }
        : {
            base: googleGenAIBase,
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
    return { baseId, trait: definition?.trait };
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
    const requester = route.base.createRequester({
      connection: route.connection,
      trait: route.trait,
      convertError: route.convertError,
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
