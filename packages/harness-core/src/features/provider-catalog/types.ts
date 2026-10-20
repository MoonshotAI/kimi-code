import type {
  CatalogModel,
  CatalogModelDefinition,
  CatalogProviderHandle,
  CatalogProviderInfo as LlmCatalogProviderInfo,
} from '@moonshot-ai/agent-core/llm/catalog/index';
import { createStaticCredentialProvider } from '@moonshot-ai/agent-core/llm/builtin/policy/credentials';
import type { LlmEndpoint, ModelThinkingMetadata } from '@moonshot-ai/agent-core/llm/request';
import type { LlmRequester } from '@moonshot-ai/agent-core/llm/requester';

import type { ModelsSection } from '#/features/config/index';

export type { CatalogModel, CatalogModelDefinition, CatalogProviderHandle };

export type CatalogModelConfig = ModelsSection[string];

export type CatalogOAuthRef = NonNullable<CatalogModelConfig['oauth']>;

export type CatalogModelOverrides = NonNullable<CatalogModelConfig['overrides']>;

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

export interface CatalogModelBinding {
  readonly providerId: string;
  readonly model: CatalogModel;
  readonly alias: string;
  readonly configKey?: string;
  readonly requester: LlmRequester<'protocol' | 'model'>;
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
    baseUrl: record.baseUrl,
    headers: record.defaultHeaders === undefined ? undefined : { ...record.defaultHeaders },
    credentials:
      record.apiKey === undefined ? undefined : createStaticCredentialProvider(record.apiKey),
  };
  return Object.values(endpoint).some((value) => value !== undefined) ? endpoint : undefined;
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
    aliases: aliases.length === 0 ? undefined : aliases,
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
