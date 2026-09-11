import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm/capability';
import type { ProviderMediaContribution } from '#/llm/media/upload';
import type { LlmConnection, LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolName } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import type { AnthropicTrait } from '#/llm/requester/bases/anthropic/trait';
import type { GoogleGenAITrait } from '#/llm/requester/bases/google-genai/trait';
import type { OpenAIResponsesTrait } from '#/llm/requester/bases/openai-responses/trait';
import type { OpenAITrait } from '#/llm/requester/bases/openai/trait';
import type { LlmErrorClassifier, LlmRequester } from '#/llm/requester/requester';

export interface ProtocolTraitsByName {
  readonly openai: OpenAITrait;
  readonly openai_responses: OpenAIResponsesTrait;
  readonly anthropic: AnthropicTrait;
  readonly 'google-genai': GoogleGenAITrait;
}

export type ProtocolTraitFor<N extends ProtocolName> = ProtocolTraitsByName[N];

export interface ProtocolBinding<N extends ProtocolName = ProtocolName> {
  readonly base: ProtocolBase<ProtocolTraitFor<N>>;
  readonly trait?: ProtocolTraitFor<N>;
  readonly connection?: ProviderConnection;
  readonly convertError?: LlmErrorClassifier;
  readonly capability?: (modelName: string) => ModelCapability | undefined;
}

export interface LlmModelSeed {
  readonly model: string;
  readonly capability?: ModelCapability;
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly baseUrl?: string;
}

export type ProviderModelSource = () => Promise<readonly LlmModelSeed[]>;

export interface ProviderDefinition {
  readonly id: string;
  readonly protocols: Readonly<{ [N in ProtocolName]?: ProtocolBinding<N> }>;
  readonly media?: ProviderMediaContribution;
  readonly models?: ProviderModelSource;
}

export interface LlmResolveModelOptions extends LlmConnection {
  readonly protocol?: ProtocolName;
}

export interface Provider {
  readonly id: string;
  readonly protocols: readonly ProtocolName[];
  readonly media?: ProviderMediaContribution;
  listModels(): Promise<readonly LlmModel[]>;
  resolveModel(model: string, options?: LlmResolveModelOptions): LlmModel;
  createRequester(protocol?: ProtocolName): LlmRequester;
}

export function createProvider(definition: ProviderDefinition): Provider {
  const entries = new Map<ProtocolName, ProtocolBinding>();
  for (const name of Object.keys(definition.protocols) as ProtocolName[]) {
    const protocol = definition.protocols[name];
    if (protocol !== undefined) {
      entries.set(name, protocol);
    }
  }
  const defaultBinding = entries.values().next().value;
  if (defaultBinding === undefined) {
    throw new Error(`provider '${definition.id}' declares no protocols`);
  }

  const bindingFor = (name: ProtocolName | undefined): ProtocolBinding => {
    if (name === undefined) {
      return defaultBinding;
    }
    const found = entries.get(name);
    if (found === undefined) {
      throw new Error(
        `provider '${definition.id}' has no protocol '${name}' (available: ${[...entries.keys()].join(', ')})`,
      );
    }
    return found;
  };

  const detectCapability = (binding: ProtocolBinding, modelName: string): ModelCapability =>
    binding.capability?.(modelName) ?? binding.base.capability?.(modelName) ?? UNKNOWN_CAPABILITY;

  return {
    id: definition.id,
    protocols: [...entries.keys()],
    media: definition.media,
    listModels: async () => {
      if (definition.models === undefined) {
        return [];
      }
      const seeds = await definition.models();
      return seeds.map((seed) => ({
        provider: definition.id,
        model: seed.model,
        capability:
          defaultBinding.capability?.(seed.model) ??
          seed.capability ??
          defaultBinding.base.capability?.(seed.model) ??
          UNKNOWN_CAPABILITY,
        maxContextSize: seed.maxContextSize,
        maxInputSize: seed.maxInputSize,
        baseUrl: seed.baseUrl,
      }));
    },
    resolveModel: (model, options = {}) => ({
      provider: definition.id,
      model,
      capability: detectCapability(bindingFor(options.protocol), model),
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      defaultHeaders: options.defaultHeaders,
      betaApi: options.betaApi,
      vertexai: options.vertexai,
    }),
    createRequester: (protocol) => {
      const binding = bindingFor(protocol);
      return binding.base.createRequester({
        connection: binding.connection,
        trait: binding.trait,
        convertError: binding.convertError,
      });
    },
  };
}
