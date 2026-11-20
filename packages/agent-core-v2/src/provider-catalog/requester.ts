import type { LlmRequester } from '@moonshot-ai/core/llm/requester';
import type { Model } from '#/provider-catalog/model/catalog';
import { getProviderDefinition } from '#/provider-catalog/provider/provider-definition';

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

