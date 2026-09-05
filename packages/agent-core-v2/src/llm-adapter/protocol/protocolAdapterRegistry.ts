import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY, toLlmCapability, type ModelCapability } from '../contract/capability';
import type { ModelThinkingMetadata } from '#human/llm/thinking';
import type { ProviderMediaContribution } from '#human/llm/media/upload';
import type { LlmModel } from '#human/llm/model';
import type { ProtocolBase, ProtocolName } from '#human/llm/protocol/base';
import type { ProtocolTrait } from '#human/llm/protocol/trait';
import { anthropicBase, anthropicBetaBase } from '#human/llm/requester/bases/anthropic/requester';
import {
  createGoogleGenAIBase,
  googleGenAIBase,
} from '#human/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#human/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';
import { KimiFiles } from '#human/llm-kimi/files';
import { KIMI_DEFAULT_BASE_URL } from '#human/llm-kimi/trait';

import type { Model } from '../model/catalog';
import type { ResolvedLlmModel } from '../model/model-requester-impl';
import {
  anthropicEndpointTrait,
  geminiEndpointTrait,
  getProviderDefinition,
  openAIEndpointTrait,
  vertexEndpointTrait,
} from '../provider/provider-definition';

import { IProtocolAdapterRegistry, type ExplainedCapability, type Protocol } from './protocol';
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
  readonly base: ProtocolBase;
  readonly trait?: ProtocolTrait;
  readonly providerId: string;
  readonly media?: ProviderMediaContribution;
}

function routeFor(model: Model): AdapterRoute {
  const definition =
    model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
  const routeTrait = definition?.routeTrait;
  const routeMedia = definition?.modelSource === 'oauth-catalog' ? kimiMedia : undefined;
  switch (model.protocol) {
    case 'openai':
      return routeTrait !== undefined
        ? { base: openAIBase, trait: routeTrait, providerId: 'openai', media: routeMedia }
        : {
            base: openAIBase,
            trait: openAITraitFor(model),
            providerId: 'openai',
          };
    case 'openai_responses':
      return routeTrait !== undefined
        ? { base: openAIResponsesBase, trait: routeTrait, providerId: 'openai-responses', media: routeMedia }
        : {
            base: openAIResponsesBase,
            trait: openAITraitFor(model),
            providerId: 'openai-responses',
          };
    case 'anthropic': {
      const base = model.providerOptions?.betaApi === true ? anthropicBetaBase : anthropicBase;
      return routeTrait !== undefined
        ? { base, trait: routeTrait, providerId: 'anthropic', media: routeMedia }
        : { base, trait: anthropicEndpointTrait, providerId: 'anthropic' };
    }
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            base: vertexGenAIBase,
            trait: vertexEndpointTrait,
            providerId: 'google_genai',
          }
        : {
            base: googleGenAIBase,
            trait: geminiEndpointTrait,
            providerId: 'google_genai',
          };
  }
}

function openAITraitFor(model: Model): ProtocolTrait {
  const reasoningKey = model.providerOptions?.reasoningKey ?? model.reasoningKey;
  if (reasoningKey === undefined) return openAIEndpointTrait;
  return { ...openAIEndpointTrait, reasoningKey: () => reasoningKey };
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
    const traits = definition?.traits ?? [];
    const context = {
      config: { protocol, providerType, modelName: '' },
      providerId: providerType,
    };
    return { baseId, traits: traits.map((trait) => ({ trait, context })) };
  }

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    return definition?.baseProtocol ?? protocol;
  }

  resolveCapability(protocol: Protocol, modelName: string, providerType?: string): ModelCapability {
    return this.explainCapability(protocol, modelName, providerType).capability;
  }

  explainCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ExplainedCapability {
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    let traitCapability: ModelCapability | undefined;
    for (const { trait } of identity.traits) {
      if (trait.capability === undefined) continue;
      const capability = trait.capability(modelName);
      if (capability !== undefined) {
        traitCapability = toV2Capability(capability);
      }
    }
    if (traitCapability !== undefined) {
      return {
        capability: traitCapability,
        source: {
          kind: 'builtin',
          detail: `trait capability hook (provider '${providerType ?? 'unregistered'}')`,
        },
      };
    }

    const baseCapability = getProtocolBase(identity.baseId)?.base.capability?.(modelName);
    if (baseCapability !== undefined) {
      return {
        capability: toV2Capability(baseCapability),
        source: { kind: 'builtin', detail: `protocol base '${identity.baseId}' catalog` },
      };
    }
    return {
      capability: UNKNOWN_CAPABILITY,
      source: { kind: 'none', detail: 'no capability source knew this model' },
    };
  }

  resolve(model: Model): ResolvedLlmModel {
    const route = routeFor(model);
    const requester = route.base.createRequester(route.trait);
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
    return { requester, protocol: protocolNameFor(model, route), model: llmModel, media: route.media };
  }
}

function protocolNameFor(model: Model, route: AdapterRoute): ProtocolName {
  switch (model.protocol) {
    case 'openai':
      return 'openai';
    case 'openai_responses':
      return 'openai_responses';
    case 'anthropic':
      return route.base === anthropicBetaBase ? 'anthropic_beta' : 'anthropic';
    case 'google-genai':
      return route.base === vertexGenAIBase ? 'google-vertex' : 'google-genai';
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
