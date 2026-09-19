import type { ProviderMediaContribution } from '#/llm/media/upload';
import { UNKNOWN_CAPABILITY, type LlmConnection, type LlmModel, type ModelCapability } from '#/llm/model';
import type { ProtocolBase, ProtocolName } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import { createRequesterFromHandle } from '#/llm/protocol/runner';
import type { LlmErrorClassifier, LlmRequester } from '#/llm/requester/requester';

export interface ProtocolBinding<TTrait = any> {
  readonly base: ProtocolBase<TTrait>;
  readonly trait?: TTrait;
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
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

export interface ProviderDefinition<P extends string = string> {
  readonly id: string;
  readonly protocols: Readonly<{ [K in P]?: ProtocolBinding | undefined }>;
  readonly media?: ProviderMediaContribution;
  readonly models?: ProviderModelSource;
}

export interface LlmResolveModelOptions extends LlmConnection {
  readonly protocol?: ProtocolName;
}

export interface Provider<P extends string = string> {
  readonly id: string;
  readonly requesters: { readonly [K in P]: LlmRequester };
  readonly media?: ProviderMediaContribution;
  listModels(): Promise<readonly LlmModel[]>;
  resolveModel(model: string, options?: LlmResolveModelOptions): LlmModel;
}

export function requesterOf(provider: Provider, protocol?: string): LlmRequester {
  const requesters = provider.requesters;
  if (protocol !== undefined) {
    const found = requesters[protocol];
    if (found === undefined) {
      throw new Error(
        `provider '${provider.id}' has no protocol '${protocol}' (available: ${Object.keys(requesters).join(', ')})`,
      );
    }
    return found;
  }
  const first = Object.values(requesters)[0];
  if (first === undefined) {
    throw new Error(`provider '${provider.id}' declares no protocols`);
  }
  return first;
}

export function createProvider<
  const TProtocols extends Readonly<Record<string, ProtocolBinding | undefined>>,
>(definition: {
  readonly id: string;
  readonly protocols: TProtocols;
  readonly media?: ProviderMediaContribution;
  readonly models?: ProviderModelSource;
}): Provider<Extract<keyof TProtocols, string>> {
  type Protocol = Extract<keyof TProtocols, string>;
  const entries = new Map<string, ProtocolBinding>();
  for (const [name, protocol] of Object.entries(definition.protocols)) {
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

  const requesters = Object.fromEntries(
    [...entries.entries()].map(([name, binding]) => [
      name,
      createRequesterFromHandle(
        binding.base.bind({
          connection: binding.connection,
          trait: binding.trait,
          classifyError: binding.classifyError,
        }),
      ),
    ]),
  ) as { readonly [K in Protocol]: LlmRequester };

  return {
    id: definition.id,
    requesters,
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
  };
}
