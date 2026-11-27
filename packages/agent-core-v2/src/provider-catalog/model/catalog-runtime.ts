import type {
  CatalogModelDefinition,
  CatalogModelOverrides,
  CatalogProviderInfo,
} from '#human/provider-catalog/catalog';
import type { ModelCapability } from '@moonshot-ai/core/llm/request';

import type { ProviderConfig } from '../provider/provider';

import type { ModelOverride, ModelRecord } from './model';
import { deriveProviderId, nonEmpty } from './model-auth';

interface CatalogModelExtras {
  readonly record: ModelRecord;
}

export function rawRecordOf(definition: CatalogModelDefinition): ModelRecord {
  return (definition.extras as unknown as CatalogModelExtras).record;
}

export function bucketOfRecord(record: ModelRecord, defaultProvider: string | undefined): string {
  const referenced = record.providerId ?? record.provider ?? defaultProvider;
  if (referenced !== undefined) return referenced;
  return deriveProviderId(nonEmpty(record.baseUrl) ?? '');
}

export function toCatalogProviderInfo(config: ProviderConfig): CatalogProviderInfo {
  return { ...config };
}

export function toCatalogModelDefinition(
  alias: string,
  record: ModelRecord,
  bucket: string,
): CatalogModelDefinition {
  return {
    id: alias,
    spec: {
      provider: bucket,
      name: record.name ?? alias,
      capability: capabilityFromDeclared(record.capabilities),
      thinking: {
        supportEfforts: record.supportEfforts,
        defaultEffort: record.defaultEffort,
        offEffort: record.offEffort,
        alwaysThinking: declaresAlwaysThinking(record.capabilities),
        adaptiveThinking: record.adaptiveThinking,
      },
      maxContextSize: record.maxContextSize,
      maxInputSize: record.maxInputSize,
    },
    endpoint: { baseUrl: record.baseUrl },
    apiKey: record.apiKey,
    displayName: record.displayName,
    maxOutputSize: record.maxOutputSize,
    reasoningKey: record.reasoningKey,
    protocol: record.protocol,
    betaApi: record.betaApi,
    aliases: record.aliases,
    oauth: record.oauth,
    overrides: toCatalogOverrides(record.overrides),
    extras: { record },
  };
}

function toCatalogOverrides(overrides: ModelOverride | undefined): CatalogModelOverrides | undefined {
  if (overrides === undefined) return undefined;
  const out: {
    -readonly [K in keyof CatalogModelOverrides]?: CatalogModelOverrides[K];
  } = {};
  if (overrides.maxContextSize !== undefined) out.maxContextSize = overrides.maxContextSize;
  if (overrides.maxInputSize !== undefined) out.maxInputSize = overrides.maxInputSize;
  if (overrides.maxOutputSize !== undefined) out.maxOutputSize = overrides.maxOutputSize;
  if (overrides.displayName !== undefined) out.displayName = overrides.displayName;
  if (overrides.reasoningKey !== undefined) out.reasoningKey = overrides.reasoningKey;
  if (overrides.adaptiveThinking !== undefined) out.adaptiveThinking = overrides.adaptiveThinking;
  if (overrides.supportEfforts !== undefined) out.supportEfforts = overrides.supportEfforts;
  if (overrides.defaultEffort !== undefined) out.defaultEffort = overrides.defaultEffort;
  if (overrides.offEffort !== undefined) out.offEffort = overrides.offEffort;
  if (overrides.capabilities !== undefined) {
    out.capability = capabilityFromDeclared(overrides.capabilities);
    out.alwaysThinking = declaresAlwaysThinking(overrides.capabilities);
  }
  return out;
}

function declaredSet(capabilities: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((capabilities ?? []).map((capability) => capability.trim().toLowerCase()));
}

function declaresAlwaysThinking(capabilities: readonly string[] | undefined): boolean {
  return declaredSet(capabilities).has('always_thinking');
}

function capabilityFromDeclared(capabilities: readonly string[] | undefined): ModelCapability {
  const declared = declaredSet(capabilities);
  return {
    image_in: declared.has('image_in'),
    video_in: declared.has('video_in'),
    audio_in: declared.has('audio_in'),
    thinking: declared.has('thinking') || declared.has('always_thinking'),
    tool_use: declared.has('tool_use'),
    dynamically_loaded_tools: declared.has('dynamically_loaded_tools'),
  };
}

