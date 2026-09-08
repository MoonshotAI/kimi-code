import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm/capability';
import type { ProviderMediaContribution } from '#/llm/media/upload';
import type { LlmConnection, LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolName } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import type { AnthropicDialect } from '#/llm/requester/bases/anthropic/dialect';
import type { GoogleGenAIDialect } from '#/llm/requester/bases/google-genai/dialect';
import type { OpenAIResponsesDialect } from '#/llm/requester/bases/openai-responses/dialect';
import type { OpenAIDialect } from '#/llm/requester/bases/openai/dialect';
import type { LlmErrorClassifier, LlmRequester } from '#/llm/requester/requester';

export interface ProtocolDialectMap {
  readonly openai: OpenAIDialect;
  readonly openai_responses: OpenAIResponsesDialect;
  readonly anthropic: AnthropicDialect;
  readonly 'google-genai': GoogleGenAIDialect;
}

export type AnyProtocolDialect = ProtocolDialectMap[ProtocolName];

export interface ProtocolVariant<N extends ProtocolName = ProtocolName> {
  readonly base: ProtocolBase<ProtocolDialectMap[N]>;
  readonly dialect?: ProtocolDialectMap[N];
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
  readonly protocols: Readonly<{ [N in ProtocolName]?: ProtocolVariant<N> }>;
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
  const entries = new Map<ProtocolName, ProtocolVariant>();
  for (const name of Object.keys(definition.protocols) as ProtocolName[]) {
    const protocol = definition.protocols[name];
    if (protocol !== undefined) {
      entries.set(name, protocol);
    }
  }
  const defaultVariant = entries.values().next().value;
  if (defaultVariant === undefined) {
    throw new Error(`provider '${definition.id}' declares no protocols`);
  }

  const variantFor = (name: ProtocolName | undefined): ProtocolVariant => {
    if (name === undefined) {
      return defaultVariant;
    }
    const found = entries.get(name);
    if (found === undefined) {
      throw new Error(
        `provider '${definition.id}' has no protocol '${name}' (available: ${[...entries.keys()].join(', ')})`,
      );
    }
    return found;
  };

  const detectCapability = (variant: ProtocolVariant, modelName: string): ModelCapability =>
    variant.capability?.(modelName) ?? variant.base.capability?.(modelName) ?? UNKNOWN_CAPABILITY;

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
          defaultVariant.capability?.(seed.model) ??
          seed.capability ??
          defaultVariant.base.capability?.(seed.model) ??
          UNKNOWN_CAPABILITY,
        maxContextSize: seed.maxContextSize,
        maxInputSize: seed.maxInputSize,
        baseUrl: seed.baseUrl,
      }));
    },
    resolveModel: (model, options = {}) => ({
      provider: definition.id,
      model,
      capability: detectCapability(variantFor(options.protocol), model),
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      defaultHeaders: options.defaultHeaders,
      betaApi: options.betaApi,
      vertexai: options.vertexai,
    }),
    createRequester: (protocol) => {
      const variant = variantFor(protocol);
      return variant.base.createRequester({
        connection: variant.connection,
        dialect: variant.dialect,
        convertError: variant.convertError,
      });
    },
  };
}
