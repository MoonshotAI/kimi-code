import type { AgentLlmRequester } from '#/agent-machine/llm-actor';
import { createStaticCredentialProvider } from '#/llm/builtin/policy/credentials';
import type {
  CatalogModel,
  CatalogModelDefinition,
  CatalogProviderHandle,
  CatalogProviderInfo as LlmCatalogProviderInfo,
} from '#/llm/catalog/index';
import type { LlmEndpoint, ModelThinkingMetadata } from '#/llm/request';

export type { CatalogModel, CatalogModelDefinition };
export type { CatalogProviderHandle } from '#/llm/catalog/index';

export interface CatalogOAuthRef {
  readonly storage: 'file' | 'keyring';
  readonly key: string;
  readonly oauthHost?: string;
}

export interface CatalogProviderInfo extends LlmCatalogProviderInfo {
  readonly apiKey?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly env?: Readonly<Record<string, string>>;
  readonly aliasScope?: string;
  readonly source?: Readonly<Record<string, unknown>>;
}

export function isOAuthBackedProvider(info: CatalogProviderInfo | undefined): boolean {
  return info?.oauth !== undefined || info?.modelSource === 'oauth-catalog';
}

export function catalogAliasPrefix(
  info: CatalogProviderInfo | undefined,
  providerId: string,
): string {
  return `${info?.aliasScope ?? providerId}/`;
}

export function catalogModelAlias(
  info: CatalogProviderInfo | undefined,
  providerId: string,
  modelId: string,
): string {
  return `${catalogAliasPrefix(info, providerId)}${modelId}`;
}

export interface CatalogModelOverrides {
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly maxOutputSize?: number;
  readonly capability?: CatalogModelDefinition['capability'];
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
}

export interface CatalogModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly capability?: CatalogModelDefinition['capability'];
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly displayName?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly protocol?: string;
  readonly defaultEffort?: string;
  readonly adaptiveThinking?: boolean;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly betaApi?: boolean;
  readonly vertexai?: boolean;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly configKey?: string;
  readonly oauth?: CatalogOAuthRef;
  readonly overrides?: CatalogModelOverrides;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface CatalogModelBinding {
  readonly providerId: string;
  readonly model: CatalogModel;
  readonly alias: string;
  readonly configKey?: string;
  readonly requester: AgentLlmRequester;
}

export interface ProviderContribution {
  readonly handle: CatalogProviderHandle;
  readonly info?: CatalogProviderInfo;
  readonly models?: readonly CatalogModelConfig[];
}

function thinkingMetadataOf(record: CatalogModelConfig): ModelThinkingMetadata | undefined {
  const { supportEfforts, defaultEffort, offEffort, alwaysThinking, adaptiveThinking } = record;
  if (
    supportEfforts === undefined &&
    defaultEffort === undefined &&
    offEffort === undefined &&
    alwaysThinking === undefined &&
    adaptiveThinking === undefined
  ) {
    return undefined;
  }
  return { supportEfforts, defaultEffort, offEffort, alwaysThinking, adaptiveThinking };
}

function foldOverrides(record: CatalogModelConfig): CatalogModelConfig {
  const overrides = record.overrides;
  if (overrides === undefined) return record;
  const folded: CatalogModelConfig = { ...record, ...overrides };
  if (
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    folded.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(folded.defaultEffort)
  ) {
    const { defaultEffort: _dropped, ...rest } = folded;
    return rest;
  }
  return folded;
}

function protocolOptionsOf(record: CatalogModelConfig): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (record.reasoningKey !== undefined) options['reasoningKey'] = record.reasoningKey;
  if (record.betaApi !== undefined) options['betaApi'] = record.betaApi;
  if (record.vertexai !== undefined) options['vertexai'] = record.vertexai;
  return Object.keys(options).length > 0 ? options : undefined;
}

function endpointOf(record: CatalogModelConfig): LlmEndpoint | undefined {
  const endpoint: LlmEndpoint = {
    ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
    ...(record.defaultHeaders === undefined ? {} : { headers: { ...record.defaultHeaders } }),
    ...(record.apiKey === undefined
      ? {}
      : { credentials: createStaticCredentialProvider(record.apiKey) }),
  };
  return Object.keys(endpoint).length > 0 ? endpoint : undefined;
}

export function catalogModelDefinitionOf(record: CatalogModelConfig): CatalogModelDefinition {
  const folded = foldOverrides(record);
  const aliases = [
    ...(folded.aliases ?? []),
    ...(folded.name === undefined ? [] : [folded.name]),
  ];
  return {
    id: folded.model,
    provider: folded.provider,
    ...(aliases.length === 0 ? {} : { aliases }),
    displayName: folded.displayName,
    capability: folded.capability,
    thinking: thinkingMetadataOf(folded),
    maxContextSize: folded.maxContextSize,
    maxInputSize: folded.maxInputSize,
    maxOutputTokens: folded.maxOutputSize,
    protocol: folded.protocol,
    protocolOptions: protocolOptionsOf(folded),
    endpoint: endpointOf(folded),
    extras: folded.extras,
  };
}

