import type { LlmRequest } from '@moonshot-ai/core/llm/request';
import type { LlmRequester } from '@moonshot-ai/core/llm/requester';
import type { Model } from '#/provider-catalog/model/catalog';
import type { Protocol } from '#/provider-catalog/protocol/protocol';
import { getProviderDefinition } from '#/provider-catalog/provider/provider-definition';

export type RequestModel = Pick<Model, 'id' | 'providerType' | 'protocol' | 'spec' | 'endpoint'>;

export function requestModelOf(request: LlmRequest): RequestModel {
  return {
    id: request.attributes?.modelAlias ?? request.model.spec.name,
    providerType: request.attributes?.providerType,
    protocol: request.protocol.name ?? protocolOfProviderId(request.model.spec.provider),
    spec: request.model.spec,
    endpoint: request.endpoint ?? {},
  };
}

function protocolOfProviderId(providerId: string): Protocol {
  switch (providerId) {
    case 'openai-responses':
      return 'openai_responses';
    case 'anthropic':
      return 'anthropic';
    case 'google_genai':
      return 'google-genai';
    default:
      return 'openai';
  }
}

interface AdapterRoute {
  readonly requester: LlmRequester<'protocol'>;
  readonly options?: unknown;
  readonly providerId: string;
}

function openAIReasoningKeyFor(model: Model): string | undefined {
  return model.providerOptions?.reasoningKey ?? model.reasoningKey;
}

export function routeFor(model: Model, presets: ProviderRequesterPresets): AdapterRoute {
  const definition =
    model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
  switch (model.protocol) {
    case 'openai':
      return {
        requester: definition?.requester ?? presets.openAI,
        options: {
          reasoningKey:
            definition?.requester === undefined ? openAIReasoningKeyFor(model) : undefined,
          toolMessageConversion: definition?.requester === undefined ? undefined : 'keep_parts',
        },
        providerId: 'openai',
      };
    case 'openai_responses':
      return {
        requester: definition?.requester ?? presets.openAIResponses,
        providerId: 'openai-responses',
      };
    case 'anthropic':
      return {
        requester: definition?.requester ?? presets.anthropic,
        options: { betaApi: model.providerOptions?.betaApi === true },
        providerId: 'anthropic',
      };
    case 'google-genai':
      return model.providerOptions?.vertexai === true
        ? {
            requester: presets.googleVertex,
            options: {
              vertexai: true,
              project: model.providerOptions?.project,
              location: model.providerOptions?.location,
            },
            providerId: 'google_genai',
          }
        : {
            requester: presets.googleGenAI,
            providerId: 'google_genai',
          };
  }
}

export interface ProviderRequesterPresets {
  readonly openAI: LlmRequester<'protocol'>;
  readonly openAIResponses: LlmRequester<'protocol'>;
  readonly anthropic: LlmRequester<'protocol'>;
  readonly googleGenAI: LlmRequester<'protocol'>;
  readonly googleVertex: LlmRequester<'protocol'>;
}

