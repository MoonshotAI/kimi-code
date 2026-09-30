import {
  createCollection,
  createToken,
  createUnit,
  inject,
  lineage,
  pushCleanup,
  shallowRef,
  useChildren,
  useCollection,
  useExpose,
  useNode,
  watch,
  type UnitNode,
} from '#/kernel/index';
import { createFeature } from '#/feature/feature';
import {
  MAIN_AGENT_ID,
  SessionStoreRef,
  useAgent,
  useAgentStore,
  useApp,
  useSession,
} from '#/feature/contribution-hooks';
import { ConfigRef, deepEqual, omitUndefined, useConfigOverlay, useConfigSection, type ConfigStore } from '#/builtin/config/index';
import { createStaticCredentialProvider } from '#/llm/builtin/requester/credentials';
import type { LlmModel } from '#/llm/model';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import { resolveThinkingEffort, resolveThinkingEffortForModel } from '#/llm/thinking';

import {
  AgentModelRef,
  MODEL_BOUND,
  ModelCatalogError,
  ModelDefaultsRef,
  SessionModelRef,
  matchCatalogBinding,
  modelBindingProjection,
  sessionModelDefaultsProjection,
  type AgentModelFace,
  type SessionModelDefaults,
} from './binding';
import { createProviderStore, type ProviderStore } from './store';
import type {
  CatalogModelBinding,
  CatalogModelConfig,
  CatalogProviderInfo,
  ProviderContribution,
} from './types';
import { materializeProvider, ProviderProtocols } from './materialize';
import {
  CredentialResolvers,
  resolveCredentialProvider,
  useCredentialResolver,
} from './credentials';
import {
  DEFAULT_MODEL_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  THINKING_CONFIG_SECTION,
  defaultModelConfigSection,
  modelCatalogConfigSection,
  modelsConfigSection,
  providersConfigSection,
  thinkingConfigSection,
  type ModelsSection,
  type ProvidersSection,
  type ThinkingConfig,
} from './configSections';
import { kimiModelEnvOverlay } from './envOverlay';

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

const STATIC_CREDENTIAL_RESOLVER_PRIORITY = 1000;

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
    useConfigSection(defaultModelConfigSection);
    useConfigOverlay(kimiModelEnvOverlay);
    const configEntries = node.providerRef(ConfigRef);
    const protocolFactories = useCollection(ProviderProtocols);
    const bindings = useCollection(CatalogModels);
    useCredentialResolver(
      {
        resolve: (info) => {
          const apiKey = resolveProviderInfo(info, configEntries.value.at(-1)?.value)?.apiKey;
          return apiKey === undefined ? undefined : createStaticCredentialProvider(apiKey);
        },
      },
      STATIC_CREDENTIAL_RESOLVER_PRIORITY,
    );
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
          .map(([key, model]) => ({ ...model, configKey: key }));
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
    useExpose(ModelDefaultsRef, {
      setDefaultModel: async (alias) => {
        if (
          matchCatalogBinding(alias, bindings.value, (providerId) =>
            store.providerInfo(providerId),
          ) === undefined
        ) {
          throw new ModelCatalogError('model.unknown_alias', `Unknown model alias '${alias}'.`);
        }
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) {
          throw new ModelCatalogError(
            'config.unavailable',
            'Cannot persist the default model: the config feature is not mounted.',
          );
        }
        await config.set(DEFAULT_MODEL_CONFIG_SECTION, alias, 'user');
      },
      setDefaultThinking: async (effort) => {
        const config = configEntries.value.at(-1)?.value;
        if (config === undefined) {
          throw new ModelCatalogError(
            'config.unavailable',
            'Cannot persist the default thinking effort: the config feature is not mounted.',
          );
        }
        const next: ThinkingConfig = {
          ...config.get<ThinkingConfig>(THINKING_CONFIG_SECTION),
          effort,
        };
        delete next.forcedEffort;
        await config.set(THINKING_CONFIG_SECTION, next, 'user');
      },
    });
    pushCleanup(node, () => {
      store.dispose();
    });
  },
  session() {
    const session = useSession();
    const app = useApp();
    const store = inject(ProviderCatalogRef);
    const bindings = useCollection(CatalogModels);
    const mainModel = (): AgentModelFace | undefined => {
      try {
        return session.get(MAIN_AGENT_ID)?.resolve(AgentModelRef);
      } catch {
        return undefined;
      }
    };
    useExpose(SessionModelRef, {
      setModel: async (alias) => {
        if (
          matchCatalogBinding(alias, bindings.value, (providerId) =>
            store.providerInfo(providerId),
          ) === undefined
        ) {
          throw new ModelCatalogError('model.unknown_alias', `Unknown model alias '${alias}'.`);
        }
        const current = await app.space.get(session.sessionId);
        await app.updateSession(session.sessionId, {
          metadata: { ...current?.metadata, defaultModel: alias },
        });
        await mainModel()?.setModel(alias);
      },
      setThinking: async (effort) => {
        await mainModel()?.setThinking(effort);
        const current = await app.space.get(session.sessionId);
        await app.updateSession(session.sessionId, {
          metadata: { ...current?.metadata, defaultThinking: effort },
        });
      },
    });
  },
  agent() {
    const agent = useAgent();
    const node = useNode();
    const store = inject(ProviderCatalogRef);
    const configEntries = node.providerRef(ConfigRef);
    const bindings = useCollection(CatalogModels);
    const resolvers = useCollection(CredentialResolvers);
    const agentStore = useAgentStore();
    const bound = agentStore.fold(modelBindingProjection);
    const sessionDefaults = shallowRef<SessionModelDefaults>({});
    const sessionStore = node.providerRef(SessionStoreRef).value.at(-1)?.value;
    if (sessionStore !== undefined) {
      const view = sessionStore.attach(sessionModelDefaultsProjection);
      sessionDefaults.value = view.getState();
      pushCleanup(node, view.subscribe((next) => {
        sessionDefaults.value = next;
      }));
      pushCleanup(node, () => view.dispose());
    }
    const resolveBinding = (alias: string): CatalogModelBinding | undefined =>
      matchCatalogBinding(alias, bindings.value, (providerId) => store.providerInfo(providerId));
    const effectiveAlias = (): string | undefined => {
      const value =
        bound.value.alias ??
        sessionDefaults.value.defaultModel ??
        configEntries.value.at(-1)?.value.section<string>(DEFAULT_MODEL_CONFIG_SECTION).value;
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    let lastApplied: LlmRequestConfig | undefined;
    const apply = (): boolean => {
      if (agent.config !== undefined && agent.config !== lastApplied) return false;
      const alias = effectiveAlias();
      if (alias === undefined) return true;
      const binding = resolveBinding(alias);
      if (binding === undefined) return true;
      const thinkingSection = configEntries.value
        .at(-1)?.value.section<ThinkingConfig>(THINKING_CONFIG_SECTION).value;
      const requested =
        bound.value.thinking ??
        sessionDefaults.value.defaultThinking ??
        thinkingSection?.forcedEffort ??
        thinkingSection?.effort;
      const next: LlmRequestConfig = {
        model: binding.model,
        thinking:
          requested === undefined
            ? undefined
            : { effort: resolveThinkingEffortForModel(requested, undefined, binding.model) },
      };
      agent.setConfig(next);
      lastApplied = next;
      agent.setRequester(binding.requester);
      const info = store.providerInfo(binding.providerId);
      const credential =
        info === undefined ? undefined : resolveCredentialProvider(info, resolvers.value);
      if (credential !== undefined) agent.setCredentialProvider(credential);
      return true;
    };
    useExpose(AgentModelRef, {
      current: bound,
      setModel: async (alias) => {
        if (resolveBinding(alias) === undefined) {
          throw new ModelCatalogError('model.unknown_alias', `Unknown model alias '${alias}'.`);
        }
        await agentStore.dispatch({ type: MODEL_BOUND, alias, thinking: bound.value.thinking });
      },
      setThinking: async (effort) => {
        const alias = effectiveAlias();
        const model =
          (alias === undefined ? undefined : resolveBinding(alias)?.model) ?? agent.config?.model;
        if (model !== undefined) {
          const resolution = resolveThinkingEffort({ effort }, model, true);
          if (!resolution.ok) {
            throw new ModelCatalogError('model.invalid_thinking', resolution.error.message);
          }
        }
        await agentStore.dispatch({ type: MODEL_BOUND, alias: bound.value.alias, thinking: effort });
      },
    });
    if (agent.config !== undefined) return;
    const stop = watch(
      () => [
        bound.value,
        sessionDefaults.value,
        configEntries.value,
        configEntries.value.at(-1)?.value.section(DEFAULT_MODEL_CONFIG_SECTION).value,
        configEntries.value.at(-1)?.value.section(THINKING_CONFIG_SECTION).value,
        bindings.value,
        resolvers.value,
      ],
      () => {
        if (!apply()) stop();
      },
      { immediate: true },
    );
    pushCleanup(node, stop);
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
