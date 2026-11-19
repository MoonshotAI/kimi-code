import { modelKey, type LlmEndpoint } from '@moonshot-ai/core/llm/request';
import {
  contentsOf,
  createRequester,
  type InitializedLlmRequester,
  type InitializedLlmRequestPart,
  type LlmRequester,
} from '@moonshot-ai/core/llm/requester';
import { createLlmHeadersTimeoutFetch } from '@moonshot-ai/core/llm/transport/headers-timeout';
import {
  createLlmRequesterExecution,
  type LlmRequesterExecution,
} from '@moonshot-ai/core/llm/policy/policy';
import type { Model } from '#/llm-adapter/model/catalog';
import { getProviderDefinition } from '#/llm-adapter/provider/provider-definition';

interface AdapterRoute {
  readonly requester: LlmRequester<'protocol'>;
  readonly options?: unknown;
  readonly providerId: string;
}

function openAIReasoningKeyFor(model: Model): string | undefined {
  return model.providerOptions?.reasoningKey ?? model.reasoningKey;
}

function routeFor(model: Model, presets: ProviderRequesterPresets): AdapterRoute {
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

export class ProviderRequesterFactory {
  constructor(
    private readonly detectedReasoningKeys: Map<string, string>,
    private readonly presets: ProviderRequesterPresets,
  ) {}

  request(
    model: Model,
    part?: InitializedLlmRequestPart,
    execution: LlmRequesterExecution = createLlmRequesterExecution(),
  ): InitializedLlmRequester {
    const route = routeFor(model, this.presets);
    const base = contentsOf(route.requester);
    const protocol = base.protocol;
    if (protocol?.base === undefined) throw new TypeError('requester protocol is not initialized');
    const protocolBase = protocol.base;
    let options = route.options;
    if (model.protocol === 'openai') {
      const resolved = options as { readonly reasoningKey?: string } | undefined;
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
