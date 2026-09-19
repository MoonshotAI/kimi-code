import {
  createCollection,
  createToken,
  createUnit,
  inject,
  pushCleanup,
  useChildren,
  useCollection,
  useExpose,
  useNode,
  watch,
  type UnitNode,
} from '#/kernel/index';
import { createFeature } from '#/feature/feature';

import { createProviderStore, type ProviderStore } from './store';
import type { CatalogModelBinding, ProviderContribution } from './types';

export const Providers = createCollection<ProviderContribution>('provider-catalog.providers');

export const CatalogModels = createCollection<CatalogModelBinding>('provider-catalog.models');

export const ProviderCatalogRef = createToken<ProviderStore>('provider-catalog');

export function useProvider(contribution: ProviderContribution, priority = 0): void {
  const node = useNode();
  pushCleanup(node, rootOf(node).contribute(Providers, contribution, priority));
}

export function useProviderCatalog(): ProviderStore {
  return inject(ProviderCatalogRef);
}

export function useCatalogModels() {
  return useCollection(CatalogModels);
}

const CatalogModelUnit = createUnit<CatalogModelBinding>('catalog-model', (props) => {
  const node = useNode();
  pushCleanup(node, rootOf(node).contribute(CatalogModels, props, 0));
});

export const providerCatalog = createFeature('provider-catalog', {
  app() {
    const node = useNode();
    const store = createProviderStore();
    const contributed = useCollection(Providers);
    const synced = new Set<string>();
    watch(
      contributed,
      (list: readonly ProviderContribution[]) => {
        const next = new Set(list.map((item) => item.provider.id));
        for (const item of list) {
          store.upsert({
            provider: item.provider,
            info: item.info,
            models: item.models,
          });
        }
        for (const providerId of synced) {
          if (!next.has(providerId)) store.remove(providerId);
        }
        synced.clear();
        for (const providerId of next) synced.add(providerId);
      },
      { immediate: true },
    );
    useChildren(() => {
      void store.snapshot.value;
      return store.providers().flatMap((providerId) =>
        store.models(providerId).flatMap((model) => {
          const binding = store.resolve(providerId, model.model);
          if (binding === undefined) return [];
          return [{ key: `${providerId}:${model.model}`, recipe: CatalogModelUnit, props: binding }];
        }),
      );
    });
    useExpose(ProviderCatalogRef, store);
    pushCleanup(node, () => {
      store.dispose();
    });
  },
});

function rootOf(node: UnitNode): UnitNode {
  let current = node;
  while (current.parent !== null) {
    current = current.parent;
  }
  return current;
}
