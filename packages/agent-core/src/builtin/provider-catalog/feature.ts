import {
  createCollection,
  createFacadeToken,
  createUnit,
  lineage,
  shallowRef,
  useChildren,
  useCleanup,
  useCollection,
  useExpose,
  useInject,
  watch,
  type ShallowRef,
  type UnitNode,
} from '#/kernel/index';
import { useNode } from '#/kernel/hooks';
import { createFeature } from '#/feature/feature';
import {
  MAIN_AGENT_ID,
  SessionStoreRef,
  useAgent,
  useAgentStore,
  useApp,
  useSession,
} from '#/feature/contribution-hooks';
import { ConfigRef, deepEqual, isPlainObject, omitUndefined, useConfigOverlay, useConfigSection, type ConfigStore } from '#/builtin/config/index';
import { createStaticCredentialProvider } from '#/llm/builtin/policy/credentials';
import {
  createProviderCatalog,
  listSnapshotModels,
  resolveSnapshotModel,
  type CatalogModel,
  type CatalogModelDefinition,
  type CatalogProviderHandle,
  type CatalogSnapshot,
  type ProviderCatalog,
} from '#/llm/catalog/index';
import type { LlmRequestModel } from '#/llm/request';
import type { LlmRequester } from '#/llm/requester';

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
import {
  catalogAliasPrefix,
  catalogModelAlias,
  catalogModelDefinitionOf,
  isOAuthBackedProvider,
  type CatalogModelBinding,
  type CatalogModelConfig,
  type CatalogProviderInfo,
  type ProviderContribution,
} from './types';
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
import { invalidThinkingEffortMessage, resolveThinkingEffortForModel } from './thinking';

export const Providers = createCollection<ProviderContribution>('provider-catalog.providers');

export const CatalogModels = createCollection<CatalogModelBinding>('provider-catalog.models');

export interface ProviderProtocolContribution {
  readonly type: string;
  protocols(info: CatalogProviderInfo): Record<string, LlmRequester<'protocol'> | undefined>;
}

export const ProviderProtocols = createCollection<ProviderProtocolContribution>(
  'provider-catalog.protocols',
);

export function useProviderProtocol(contribution: ProviderProtocolContribution, priority = 0): void {
  useCleanup(
    ([...lineage(useNode())].at(-1) as UnitNode).contribute(ProviderProtocols, contribution, priority),
  );
}

export interface ProviderCatalogFace {
  snapshot(): ReturnType<ProviderCatalog['snapshot']>;
  providers(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  models(providerId: string): readonly CatalogModel[];
  model(providerId: string, modelId: string): CatalogModel | undefined;
  requester(providerId: string, modelId: string): ReturnType<ProviderCatalog['requester']>;
  upsert(input: Parameters<ProviderCatalog['upsert']>[0]): void;
  bind(handle: CatalogProviderHandle): void;
  remove(providerId: string): void;
  refresh(target: Parameters<ProviderCatalog['refresh']>[0]): void;
  ping(providerId: string, modelId: string): void;
  onChanged(listener: Parameters<ProviderCatalog['onChanged']>[0]): () => void;
  onRefreshFailed(listener: Parameters<ProviderCatalog['onRefreshFailed']>[0]): () => void;
  isLive(providerId: string): boolean;
  close(): void;
}

export const ProviderCatalogRef = createFacadeToken<ProviderCatalogFace>('provider-catalog');

export function useProvider(contribution: ProviderContribution, priority = 0): void {
  useCleanup(
    ([...lineage(useNode())].at(-1) as UnitNode).contribute(Providers, contribution, priority),
  );
}

export function useProviderCatalog(): Readonly<ShallowRef<ProviderCatalogFace | undefined>> {
  return useInject(ProviderCatalogRef);
}

const STATIC_CREDENTIAL_RESOLVER_PRIORITY = 1000;

const CatalogModelUnit = createUnit<CatalogModelBinding>('catalog-model', (props) => {
  useCleanup(([...lineage(useNode())].at(-1) as UnitNode).contribute(CatalogModels, props, 0));
});

function materializeHandle(
  providerId: string,
  info: CatalogProviderInfo | undefined,
  contributions: readonly ProviderProtocolContribution[],
): CatalogProviderHandle | undefined {
  if (info === undefined || isOAuthBackedProvider(info)) return undefined;
  const type = info.type;
  if (type === undefined) return undefined;
  const factory = contributions.findLast((contribution) => contribution.type === type);
  if (factory === undefined) return undefined;
  const protocols = factory.protocols(info);
  const entries = Object.fromEntries(
    Object.entries(protocols).filter(
      (entry): entry is [string, LlmRequester<'protocol'>] => entry[1] !== undefined,
    ),
  );
  if (Object.keys(entries).length === 0) return undefined;
  return {
    id: providerId,
    requester: entries,
    listModels:
      info.modelSource === 'discover' ? () => discoverProviderModels(providerId, info) : undefined,
  };
}

async function discoverProviderModels(
  providerId: string,
  info: CatalogProviderInfo,
): Promise<readonly CatalogModelDefinition[]> {
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
  const seeds: CatalogModelDefinition[] = [];
  for (const item of payload['data']) {
    if (isPlainObject(item) && typeof item['id'] === 'string') {
      seeds.push({ id: item['id'], provider: providerId });
    }
  }
  return seeds;
}

export const providerCatalog = createFeature('provider-catalog', {
  app() {
    const live = new Set<string>();
    const glueHandles = new Map<string, CatalogProviderHandle>();
    const configKeys = new Map<string, Map<string, string>>();
    let catalog: ProviderCatalog | undefined;
    const ready = shallowRef(false);
    const snapshotRef = shallowRef<CatalogSnapshot>({ providers: {} });
    const pendingChanged: Parameters<ProviderCatalog['onChanged']>[0][] = [];
    const pendingFailed: Parameters<ProviderCatalog['onRefreshFailed']>[0][] = [];
    const face: ProviderCatalogFace = {
      snapshot: () => snapshotRef.value,
      providers: () => Object.keys(snapshotRef.value.providers).toSorted(),
      providerInfo: (providerId) =>
        snapshotRef.value.providers[providerId]?.info as CatalogProviderInfo | undefined,
      models: (providerId) => listSnapshotModels(providerId, snapshotRef.value.providers[providerId]),
      model: (providerId, modelId) =>
        resolveSnapshotModel(providerId, snapshotRef.value.providers[providerId], modelId),
      requester: (providerId, modelId) =>
        catalog === undefined ? undefined : catalog.requester(providerId, modelId),
      upsert: (input) => {
        if (catalog === undefined) return;
        if (input.handle !== undefined) {
          glueHandles.set(input.providerId ?? input.handle.id, input.handle);
          live.add(input.providerId ?? input.handle.id);
        }
        catalog.upsert(input);
        if (input.handle !== undefined) bump();
      },
      bind: (handle) => {
        if (catalog === undefined) return;
        glueHandles.set(handle.id, handle);
        live.add(handle.id);
        catalog.bind(handle);
        bump();
      },
      remove: (providerId) => {
        if (catalog === undefined) return;
        glueHandles.delete(providerId);
        live.delete(providerId);
        catalog.remove(providerId);
      },
      refresh: (target) => {
        if (catalog === undefined) return;
        let bumped = false;
        for (const item of Array.isArray(target) ? target : [target]) {
          if (typeof item !== 'string') {
            glueHandles.set(item.id, item);
            live.add(item.id);
            bumped = true;
          }
        }
        catalog.refresh(target);
        if (bumped) bump();
      },
      ping: (providerId, modelId) => {
        if (catalog === undefined) return;
        catalog.ping(providerId, modelId);
      },
      onChanged: (listener) => {
        if (catalog === undefined) {
          pendingChanged.push(listener);
          return () => {
            const index = pendingChanged.indexOf(listener);
            if (index >= 0) pendingChanged.splice(index, 1);
          };
        }
        return catalog.onChanged(listener);
      },
      onRefreshFailed: (listener) => {
        if (catalog === undefined) {
          pendingFailed.push(listener);
          return () => {
            const index = pendingFailed.indexOf(listener);
            if (index >= 0) pendingFailed.splice(index, 1);
          };
        }
        return catalog.onRefreshFailed(listener);
      },
      isLive: (providerId) => live.has(providerId),
      close: () => catalog?.close(),
    };
    const bump = (): void => {
      if (catalog === undefined) return;
      snapshotRef.value = { providers: { ...catalog.snapshot().providers } };
    };
    useExpose(ProviderCatalogRef, face);
    void createProviderCatalog().then((created) => {
      catalog = created;
      for (const listener of pendingChanged.splice(0)) catalog.onChanged(listener);
      for (const listener of pendingFailed.splice(0)) catalog.onRefreshFailed(listener);
      catalog.onChanged((event) => {
        snapshotRef.value = created.snapshot();
        const current = config.value;
        if (current === undefined) return;
        const currentModels = current.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
        const next: Record<string, CatalogModelConfig> = { ...currentModels };
        let changed = false;
        for (const providerId of event.providers) {
          const entry = created.snapshot().providers[providerId];
          if (entry === undefined) continue;
          const discovered = Object.values(entry.discovered);
          if (discovered.length === 0) continue;
          const prefix = catalogAliasPrefix(entry.info as CatalogProviderInfo | undefined, providerId);
          const upstreamKeys = new Set(
            discovered.map((definition) => `${prefix}${definition.id}`),
          );
          for (const [key, record] of Object.entries(currentModels)) {
            if (record.provider !== providerId || !key.startsWith(prefix)) continue;
            if (!upstreamKeys.has(key)) {
              delete next[key];
              changed = true;
            }
          }
          for (const definition of discovered) {
            const record = omitUndefined({
              provider: definition.provider ?? providerId,
              model: definition.name ?? definition.id,
              capability: definition.capability,
              maxContextSize: definition.maxContextSize,
              maxInputSize: definition.maxInputSize,
              baseUrl: definition.endpoint?.baseUrl,
            }) as CatalogModelConfig;
            if (!deepEqual(currentModels[`${prefix}${definition.id}`], record)) {
              next[`${prefix}${definition.id}`] = record;
              changed = true;
            }
          }
        }
        if (!changed) return;
        void current.set(MODELS_CONFIG_SECTION, next, 'user').catch(() => {});
      });
      ready.value = true;
    });
    useCleanup(() => {
      catalog?.close();
    });

    const contributed = useCollection(Providers);
    const protocolFactories = useCollection(ProviderProtocols);
    const bindings = useCollection(CatalogModels);
    const resolvers = useCollection(CredentialResolvers);
    const config = useInject(ConfigRef);
    useConfigSection(providersConfigSection);
    useConfigSection(modelsConfigSection);
    useConfigSection(thinkingConfigSection);
    useConfigSection(modelCatalogConfigSection);
    useConfigSection(defaultModelConfigSection);
    useConfigOverlay(kimiModelEnvOverlay);
    useCredentialResolver(
      {
        resolve: (info) => {
          const apiKey = resolveProviderInfo(info, config.value)?.apiKey;
          return apiKey === undefined ? undefined : createStaticCredentialProvider(apiKey);
        },
      },
      STATIC_CREDENTIAL_RESOLVER_PRIORITY,
    );

    const credentialsFor = (
      handle: CatalogProviderHandle | undefined,
      info: CatalogProviderInfo | undefined,
    ): CatalogProviderHandle | undefined => {
      if (handle === undefined) return undefined;
      const credential =
        info === undefined ? undefined : resolveCredentialProvider(info, resolvers.value);
      if (credential === undefined) return handle;
      return { ...handle, endpoint: { ...handle.endpoint, credentials: credential } };
    };

    const synced = new Set<string>();
    const syncContributed = (list: readonly ProviderContribution[]): void => {
      if (!ready.value) return;
      const next = new Set(list.map((item) => item.handle.id));
      for (const item of list) {
        synced.add(item.handle.id);
        face.upsert({
          providerId: item.handle.id,
          handle: credentialsFor(item.handle, item.info),
          info: item.info,
          models: (item.models ?? []).map(catalogModelDefinitionOf),
        });
      }
      for (const providerId of Array.from(synced)) {
        if (!next.has(providerId)) {
          synced.delete(providerId);
          face.remove(providerId);
        }
      }
    };
    watch(
      () => [ready.value, contributed.value] as const,
      ([, list]) => {
        syncContributed(list);
      },
      { immediate: true },
    );

    let managed = new Set<string>();
    const reconcileConfig = (): void => {
      const cat = catalog;
      if (!ready.value || cat === undefined) return;
      const current = config.value;
      const providersSection = current?.section<ProvidersSection>(PROVIDERS_CONFIG_SECTION).value ?? {};
      const modelsSection = current?.section<ModelsSection>(MODELS_CONFIG_SECTION).value ?? {};
      const nextManaged = new Set<string>([
        ...Object.keys(providersSection),
        ...Object.values(modelsSection).map((model) => model.provider),
      ]);
      const stale = [...managed].filter((providerId) => !nextManaged.has(providerId));
      managed = nextManaged;
      for (const providerId of nextManaged) {
        const info = resolveProviderInfo(providersSection[providerId], current);
        const prefix = catalogAliasPrefix(info, providerId);
        const models = Object.entries(modelsSection)
          .filter(([, model]) => model.provider === providerId)
          .toSorted((a, b) => Number(b[0].startsWith(prefix)) - Number(a[0].startsWith(prefix)));
        configKeys.set(
          providerId,
          new Map(models.map(([key, model]) => [model.model, key])),
        );
        const definitions = models.map(([, model]) => catalogModelDefinitionOf(model));
        const entry = cat.snapshot().providers[providerId];
        const drifted =
          entry === undefined ||
          !deepEqual(entry.info, info) ||
          !deepEqual(
            entry.override,
            Object.fromEntries(definitions.map((definition) => [definition.id, definition])),
          );
        const handle = credentialsFor(
          materializeHandle(providerId, info, protocolFactories.value),
          info,
        );
        const hadHandle = handle !== undefined && !synced.has(providerId);
        const shouldRefresh =
          hadHandle && handle.listModels !== undefined && !face.isLive(providerId);
        if (drifted || !face.isLive(providerId)) {
          cat.upsert({
            providerId,
            info,
            models: definitions,
            ...(hadHandle ? { handle, refresh: shouldRefresh } : {}),
          });
          if (hadHandle) {
            live.add(providerId);
          }
        }
      }
      for (const providerId of stale) {
        configKeys.delete(providerId);
        const item = contributed.value.find((entry) => entry.handle.id === providerId);
        if (item === undefined) {
          face.remove(providerId);
        } else {
          face.upsert({
            providerId,
            handle: credentialsFor(item.handle, item.info),
            info: item.info,
            models: (item.models ?? []).map(catalogModelDefinitionOf),
          });
        }
      }
    };
    watch(
      () => {
        const current = config.value;
        return [
          ready.value,
          current?.section(PROVIDERS_CONFIG_SECTION).value,
          current?.section(MODELS_CONFIG_SECTION).value,
          contributed.value,
          protocolFactories.value,
        ];
      },
      reconcileConfig,
      { immediate: true, scheduler: coalescedMicrotaskScheduler() },
    );
    watch(resolvers, () => {
      const cat = catalog;
      if (!ready.value || cat === undefined) return;
      for (const providerId of live) {
        const handle = glueHandles.get(providerId);
        const info = face.providerInfo(providerId);
        if (handle === undefined || info === undefined) continue;
        const credential = resolveCredentialProvider(info, resolvers.value);
        cat.bind(
          credential === undefined
            ? handle
            : { ...handle, endpoint: { ...handle.endpoint, credentials: credential } },
        );
      }
    });

    useChildren(() => {
      if (!ready.value) return [];
      void snapshotRef.value;
      return face.providers().flatMap((providerId) =>
        face.models(providerId).flatMap((model) => {
          const requester = face.requester(providerId, model.id);
          if (requester === undefined) return [];
          const info = face.providerInfo(providerId);
          const binding: CatalogModelBinding = {
            providerId,
            model,
            alias: catalogModelAlias(info, providerId, model.id),
            configKey: configKeys.get(providerId)?.get(model.id),
            requester,
          };
          return [{ key: `${providerId}:${model.id}`, recipe: CatalogModelUnit, props: binding }];
        }),
      );
    });

    useExpose(ModelDefaultsRef, {
      setDefaultModel: async (alias) => {
        if (matchCatalogBinding(alias, bindings.value) === undefined) {
          throw new ModelCatalogError('model.unknown_alias', `Unknown model alias '${alias}'.`);
        }
        const current = config.value;
        if (current === undefined) {
          throw new ModelCatalogError(
            'config.unavailable',
            'Cannot persist the default model: the config feature is not mounted.',
          );
        }
        await current.set(DEFAULT_MODEL_CONFIG_SECTION, alias, 'user');
      },
      setDefaultThinking: async (effort) => {
        const current = config.value;
        if (current === undefined) {
          throw new ModelCatalogError(
            'config.unavailable',
            'Cannot persist the default thinking effort: the config feature is not mounted.',
          );
        }
        const next: ThinkingConfig = {
          ...current.get<ThinkingConfig>(THINKING_CONFIG_SECTION),
          effort,
        };
        delete next.forcedEffort;
        await current.set(THINKING_CONFIG_SECTION, next, 'user');
      },
    });
  },
  session() {
    const session = useSession();
    const app = useApp();
    const store = useInject(ProviderCatalogRef).value;
    if (store === undefined) throw new Error("no provider for token 'provider-catalog'");
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
        if (matchCatalogBinding(alias, bindings.value) === undefined) {
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
    const store = useInject(ProviderCatalogRef).value;
    if (store === undefined) throw new Error("no provider for token 'provider-catalog'");
    const config = useInject(ConfigRef);
    const bindings = useCollection(CatalogModels);
    const resolvers = useCollection(CredentialResolvers);
    const agentStore = useAgentStore();
    const bound = agentStore.fold(modelBindingProjection);
    const sessionDefaults = shallowRef<SessionModelDefaults>({});
    const sessionStore = node.providerRef(SessionStoreRef).value.at(-1)?.value;
    if (sessionStore !== undefined) {
      const view = sessionStore.attach(sessionModelDefaultsProjection);
      sessionDefaults.value = view.getState();
      useCleanup(view.subscribe((next) => {
        sessionDefaults.value = next;
      }));
      useCleanup(() => view.dispose());
    }
    const resolveBinding = (alias: string): CatalogModelBinding | undefined =>
      matchCatalogBinding(alias, bindings.value);
    const effectiveAlias = (): string | undefined => {
      const value =
        bound.value.alias ??
        sessionDefaults.value.defaultModel ??
        config.value?.section<string>(DEFAULT_MODEL_CONFIG_SECTION).value;
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    let lastApplied: LlmRequestModel | undefined;
    const apply = (): boolean => {
      if (agent.model !== undefined && agent.model !== lastApplied) return false;
      const alias = effectiveAlias();
      if (alias === undefined) return true;
      const binding = resolveBinding(alias);
      if (binding === undefined) return true;
      const thinkingSection = config.value?.section<ThinkingConfig>(THINKING_CONFIG_SECTION).value;
      const requested =
        bound.value.thinking ??
        sessionDefaults.value.defaultThinking ??
        thinkingSection?.forcedEffort ??
        thinkingSection?.effort;
      const spec = binding.model;
      const next: LlmRequestModel = {
        spec,
        thinking:
          requested === undefined
            ? undefined
            : { effort: resolveThinkingEffortForModel(requested, spec) },
      };
      agent.setModel(next);
      lastApplied = next;
      agent.setRequester(binding.requester);
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
        const boundModel = alias === undefined ? undefined : resolveBinding(alias)?.model;
        const spec = boundModel ?? agent.model?.spec;
        if (spec !== undefined) {
          const message = invalidThinkingEffortMessage(spec, effort);
          if (message !== undefined) {
            throw new ModelCatalogError('model.invalid_thinking', message);
          }
        }
        await agentStore.dispatch({ type: MODEL_BOUND, alias: bound.value.alias, thinking: effort });
      },
    });
    if (agent.model !== undefined) return;
    const stop = watch(
      () => [
        bound.value,
        sessionDefaults.value,
        config.value,
        config.value?.section(DEFAULT_MODEL_CONFIG_SECTION).value,
        config.value?.section(THINKING_CONFIG_SECTION).value,
        bindings.value,
        resolvers.value,
      ],
      () => {
        if (!apply()) stop();
      },
      { immediate: true },
    );
    useCleanup(stop);
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
