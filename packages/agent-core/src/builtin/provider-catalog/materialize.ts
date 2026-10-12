import { createCollection, lineage, useCleanup, type UnitNode } from '#/kernel/index';
import { useNode } from '#/kernel/hooks';
import { createProvider, type LlmModelSeed, type ProtocolBinding, type Provider } from '#/llm/provider';
import { isPlainObject } from '#/builtin/config/index';

import { isOAuthBackedProvider, type CatalogProviderInfo } from './types';

export interface ProviderProtocolContribution {
  readonly type: string;
  protocols(info: CatalogProviderInfo): Record<string, ProtocolBinding | undefined>;
}

export const ProviderProtocols = createCollection<ProviderProtocolContribution>(
  'provider-catalog.protocols',
);

export function useProviderProtocol(contribution: ProviderProtocolContribution, priority = 0): void {
  useCleanup(
    ([...lineage(useNode())].at(-1) as UnitNode).contribute(ProviderProtocols, contribution, priority),
  );
}

export function materializeProvider(
  providerId: string,
  info: CatalogProviderInfo | undefined,
  contributions: readonly ProviderProtocolContribution[],
): Provider | undefined {
  if (info === undefined || isOAuthBackedProvider(info)) return undefined;
  const type = info.type;
  if (type === undefined) return undefined;
  const factory = contributions.findLast((contribution) => contribution.type === type);
  if (factory === undefined) return undefined;
  const protocols = factory.protocols(info);
  if (Object.values(protocols).every((binding) => binding === undefined)) return undefined;
  return createProvider({
    id: providerId,
    protocols,
    models: info.modelSource === 'discover' ? () => discoverProviderModels(info) : undefined,
  });
}

async function discoverProviderModels(info: CatalogProviderInfo): Promise<readonly LlmModelSeed[]> {
  const baseUrl = info.baseUrl;
  if (baseUrl === undefined) return [];
  const headers: Record<string, string> = { ...info.customHeaders };
  if (info.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${info.apiKey}`;
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers });
  if (!response.ok) {
    throw new Error(`model discovery failed for '${baseUrl}': HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isPlainObject(payload) || !Array.isArray(payload['data'])) return [];
  const seeds: LlmModelSeed[] = [];
  for (const item of payload['data']) {
    if (isPlainObject(item) && typeof item['id'] === 'string') {
      seeds.push({ model: item['id'] });
    }
  }
  return seeds;
}
