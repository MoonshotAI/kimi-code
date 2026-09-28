import {
  createCollection,
  createToken,
  createUnit,
  inject,
  lineage,
  pushCleanup,
  useChildren,
  useCollection,
  useExpose,
  useNode,
  watch,
  type UnitNode,
} from '#/kernel/index';
import { createFeature } from '#/feature/feature';
import { ConfigRef, deepEqual, omitUndefined, useConfigSection, type ConfigStore } from '#/builtin/config/index';
import type { LlmModel } from '#/llm/model';

import { createProviderStore, type ProviderStore } from './store';
import type {
  CatalogModelBinding,
  CatalogModelConfig,
  CatalogProviderInfo,
  ProviderContribution,
} from './types';
import { materializeProvider, ProviderProtocols } from './materialize';
import {
  MODELS_CONFIG_SECTION,
  MODEL_CATALOG_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  THINKING_CONFIG_SECTION,
  modelCatalogConfigSection,
  modelsConfigSection,
  providersConfigSection,
  thinkingConfigSection,
  type ModelsSection,
  type ProvidersSection,
} from './configSections';

export const Providers = createCollection<ProviderContribution>('provider-catalog.providers');

export const CatalogModels = createCollection<CatalogModelBinding>('provider-catalog.models');

export const ProviderCatalogRef = createToken<ProviderStore>('provider-catalog');

export function useProvider(contribution: ProviderContribution, priority = 0): void {
  const node = useNode();
  pushCleanup(node, ([...lineage(node)].at(-1) as UnitNode).contribute(Providers, contribution, priority));
}

export function useProviderCatalog(): ProviderStore {
  return inject(ProviderCatalogRef);
}

const CatalogModelUnit = createUnit<CatalogModelBinding>('catalog-model', (props) => {
  const node = useNode();
  pushCleanup(node, ([...lineage(node)].at(-1) as UnitNode).contribute(CatalogModels, props, 0));
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
    useConfigSection(providersConfigSection);
    useConfigSection(modelsConfigSection);
    useConfigSection(thinkingConfigSection);
    useConfigSection(modelCatalogConfigSection);
    const configEntries = node.providerRef(ConfigRef);
    const protocolFactories = useCollection(ProviderProtocols);
    let managed = new Set<string>();
    const reconcileConfig = (): void => {
      const config = configEntries.value.at(-1)?.value;
      const providersSection = config?.section<ProvidersSection>(PROVIDERS_CONFIG_SECTION).value ?? {};
      const modelsSection = config?.section<ModelsSection>(MODELS_CONFIG_SECTION).value ?? {};
      const nextManaged = new Set<string>([
        ...Object.keys(providersSection),
        ...Object.values(modelsSection).map((model) => model.provider),
      ]);
      const stale = [...managed].filter((providerId) => !nextManaged.has(providerId));
      managed = nextManaged;
      for (const providerId of nextManaged) {
        const info = resolveProviderInfo(providersSection[providerId], config);
        const prefix = `${info?.aliasScope ?? providerId}/`;
        const models = Object.entries(modelsSection)
          .filter(([, model]) => model.provider === providerId)
          .toSorted((a, b) => Number(b[0].startsWith(prefix)) - Number(a[0].startsWith(prefix)))
          .map(([, model]) => model);
        const entry = store.snapshot.value.providers[providerId];
        if (
          entry === undefined ||
          !deepEqual(entry.info, info) ||
          !deepEqual(
            entry.override,
            Object.fromEntries(models.map((model) => [model.model, model])),
          )
        ) {
          store.configure({ providerId, info, models });
        }
        if (!store.isLive(providerId)) {
          const provider = materializeProvider(providerId, info, protocolFactories.value);
          if (provider !== undefined) store.refresh(provider);
        }
      }
      for (const providerId of stale) {
        const item = contributed.value.find((entry) => entry.provider.id === providerId);
        if (item === undefined) {
          store.remove(providerId);
        } else {
          store.upsert({ provider: item.provider, info: item.info, models: item.models });
        }
      }
    };
    watch(
      () => {
        const config = configEntries.value.at(-1)?.value;
        return [
          config?.section(PROVIDERS_CONFIG_SECTION).value,
          config?.section(MODELS_CONFIG_SECTION).value,
          contributed.value,
          protocolFactories.value,
          store.snapshot.value,
        ];
      },
      reconcileConfig,
      { immediate: true, scheduler: coalescedMicrotaskScheduler() },
    );
    watch(store.snapshot, () => {
      const config = configEntries.value.at(-1)?.value;
      if (config === undefined) return;
      const current = config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
      const next: Record<string, CatalogModelConfig> = { ...current };
      let changed = false;
      for (const [providerId, entry] of Object.entries(store.snapshot.value.providers)) {
        const discovered = Object.values(entry.discovered);
        if (discovered.length === 0) continue;
        const prefix = `${entry.info?.aliasScope ?? providerId}/`;
        const upstreamKeys = new Set(discovered.map((model) => `${prefix}${model.model}`));
        for (const [key, record] of Object.entries(current)) {
          if (record.provider !== providerId || !key.startsWith(prefix)) continue;
          if (!upstreamKeys.has(key)) {
            delete next[key];
            changed = true;
          }
        }
        for (const model of discovered) {
          const record = discoveredModelRecord(model);
          if (!deepEqual(current[`${prefix}${model.model}`], record)) {
            next[`${prefix}${model.model}`] = record;
            changed = true;
          }
        }
      }
      if (!changed) return;
      void config.set(MODELS_CONFIG_SECTION, next, 'user').catch(() => {});
    });
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

function coalescedMicrotaskScheduler(): (job: () => void, isFirstRun: boolean) => void {
  let queued = false;
  return (job) => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      job();
    });
  };
}

function resolveProviderInfo(
  info: CatalogProviderInfo | undefined,
  config: ConfigStore | undefined,
): CatalogProviderInfo | undefined {
  if (info === undefined || config === undefined) return info;
  const readEnvField = (field: string): string | undefined => {
    const name = info.env?.[field];
    return name === undefined ? undefined : config.env(name);
  };
  const apiKey = info.apiKey ?? readEnvField('apiKey');
  const baseUrl = info.baseUrl ?? readEnvField('baseUrl');
  if (apiKey === info.apiKey && baseUrl === info.baseUrl) return info;
  return omitUndefined({ ...info, apiKey, baseUrl });
}

function discoveredModelRecord(model: LlmModel): CatalogModelConfig {
  return omitUndefined({
    provider: model.provider,
    model: model.model,
    capability: model.capability,
    maxContextSize: model.maxContextSize,
    maxInputSize: model.maxInputSize,
    baseUrl: model.baseUrl,
  }) as CatalogModelConfig;
}
