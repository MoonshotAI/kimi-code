import { createCollection, lineage, pushCleanup, useNode, type UnitNode } from '#/kernel/index';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

import type { CatalogProviderInfo } from './types';

export interface CredentialResolverContribution {
  resolve(info: CatalogProviderInfo): LlmCredentialProvider | undefined;
}

export const CredentialResolvers = createCollection<CredentialResolverContribution>(
  'provider-catalog.credential-resolvers',
);

export function useCredentialResolver(
  contribution: CredentialResolverContribution,
  priority = 0,
): void {
  const node = useNode();
  pushCleanup(
    node,
    ([...lineage(node)].at(-1) as UnitNode).contribute(CredentialResolvers, contribution, priority),
  );
}

export function resolveCredentialProvider(
  info: CatalogProviderInfo,
  contributions: readonly CredentialResolverContribution[],
): LlmCredentialProvider | undefined {
  for (const contribution of contributions) {
    const provider = contribution.resolve(info);
    if (provider !== undefined) return provider;
  }
  return undefined;
}
