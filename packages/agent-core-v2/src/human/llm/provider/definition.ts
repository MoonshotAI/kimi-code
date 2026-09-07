import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm/capability';
import type { ProviderMediaContribution } from '#/llm/media/upload';
import type { LlmConnection, LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolName } from '#/llm/protocol/base';
import type { ProtocolTrait } from '#/llm/protocol/trait';
import type { LlmRequester } from '#/llm/requester/requester';

export interface ProviderProtocolDefinition {
  readonly base: ProtocolBase;
  readonly trait?: ProtocolTrait;
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
  readonly protocols: Readonly<Partial<Record<ProtocolName, ProviderProtocolDefinition>>>;
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

interface ProviderProtocolEntry {
  readonly name: ProtocolName;
  readonly base: ProtocolBase;
  readonly trait?: ProtocolTrait;
}

export function createProvider(definition: ProviderDefinition): Provider {
  const entries: ProviderProtocolEntry[] = [];
  for (const name of Object.keys(definition.protocols) as ProtocolName[]) {
    const protocol = definition.protocols[name];
    if (protocol !== undefined) {
      entries.push({ name, base: protocol.base, trait: protocol.trait });
    }
  }
  const defaultEntry = entries[0];
  if (defaultEntry === undefined) {
    throw new Error(`provider '${definition.id}' declares no protocols`);
  }

  const protocolFor = (name: ProtocolName | undefined): ProviderProtocolEntry => {
    if (name === undefined) {
      return defaultEntry;
    }
    const found = entries.find((entry) => entry.name === name);
    if (found === undefined) {
      throw new Error(
        `provider '${definition.id}' has no protocol '${name}' (available: ${entries.map((entry) => entry.name).join(', ')})`,
      );
    }
    return found;
  };

  const detectCapability = (
    entry: ProviderProtocolEntry,
    modelName: string,
  ): ModelCapability =>
    entry.trait?.capability?.(modelName) ??
    entry.base.capability?.(modelName) ??
    UNKNOWN_CAPABILITY;

  return {
    id: definition.id,
    protocols: entries.map((entry) => entry.name),
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
          defaultEntry.trait?.capability?.(seed.model) ??
          seed.capability ??
          defaultEntry.base.capability?.(seed.model) ??
          UNKNOWN_CAPABILITY,
        maxContextSize: seed.maxContextSize,
        maxInputSize: seed.maxInputSize,
        baseUrl: seed.baseUrl,
      }));
    },
    resolveModel: (model, options = {}) => {
      const entry = protocolFor(options.protocol);
      return {
        provider: definition.id,
        model,
        capability: detectCapability(entry, model),
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        defaultHeaders: options.defaultHeaders,
      };
    },
    createRequester: (protocol) => {
      const entry = protocolFor(protocol);
      return entry.base.createRequester(entry.trait);
    },
  };
}
