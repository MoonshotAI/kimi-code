import { createFeature, useApp, useSession } from '@moonshot-ai/agent-core/app/index';
import { onScopeDispose } from '@vue/reactivity';
import {
  createCollection,
  createFacadeToken,
  shallowRef,
  useCleanup,
  useCollection,
  useContribute,
  useExpose,
  useInject,
  watch,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit } from '@moonshot-ai/agent-core/kernel/runtime';
import { createProviderCatalog } from '@moonshot-ai/agent-core/llm/catalog/index';
import type {
  CatalogModel,
  CatalogModelDefinition,
  CatalogProviderHandle,
  CatalogSnapshot,
  ProviderCatalog,
} from '@moonshot-ai/agent-core/llm/catalog/index';
import { createStaticCredentialProvider, credentialsRecovery } from '@moonshot-ai/agent-core/llm/builtin/policy/credentials';
import type { LlmModelSpec } from '@moonshot-ai/agent-core/llm/request';
import type { LlmRequester } from '@moonshot-ai/agent-core/llm/requester';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import {
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  THINKING_CONFIG_SECTION,
  deepEqual,
  isPlainObject,
  omitUndefined,
  defaultModelConfigSection,
  modelCatalogConfigSection,
  modelsConfigSection,
  providersConfigSection,
  thinkingConfigSection,
  useConfigOverlay,
  useConfigSection,
  type ConfigStore,
  type ModelsSection,
  type ProvidersSection,
  type ThinkingConfig,
} from '#/features/config/index';
import {
  featureWriterOf,
  harnessInternals,
  useAgentRuntime,
  useFeatureStore,
  useLlmRecovery,
} from '#/runtime/index';

import {
  AgentModelRef,
  MODEL_BOUND,
  ModelCatalogError,
  ModelDefaultsRef,
  SESSION_MODEL_DEFAULTS,
  SessionModelRef,
  matchCatalogBinding,
  modelBindingProjection,
  sessionModelDefaultsProjection,
  type ModelBoundEvent,
  type SessionModelDefaultsEvent,
} from './binding';
import { CredentialResolvers, resolveCredentialProvider, useCredentialResolver } from './credentials';
import { kimiModelEnvOverlay } from './envOverlay';
import { invalidThinkingEffortMessage, resolveThinkingEffortForModel } from './thinking';
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
  useContribute(ProviderProtocols, contribution, priority);
}

export interface ProviderCatalogFace {
  snapshot(): CatalogSnapshot;
  providers(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  models(providerId: string): readonly CatalogModel[];
  model(providerId: string, modelId: string): CatalogModel | undefined;
  requester(providerId: string, modelId: string): LlmRequester<'protocol' | 'model'> | undefined;
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
  useContribute(Providers, contribution, priority);
}

export function useProviderCatalog(): Readonly<ShallowRef<ProviderCatalogFace | undefined>> {
  return useInject(ProviderCatalogRef);
}

const STATIC_CREDENTIAL_RESOLVER_PRIORITY = 1000;

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

export const providerCatalog = createFeature<ModelBoundEvent | SessionModelDefaultsEvent>(
  'provider-catalog',
  {
    app() {
      const node = currentUnit();
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
        models: (providerId) => {
          const cat = catalog;
          return cat === undefined ? [] : cat.models(providerId);
        },
        model: (providerId, modelId) => {
          const cat = catalog;
          return cat === undefined ? undefined : cat.model(providerId, modelId);
        },
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

      const config = useInject(ConfigRef);
      void createProviderCatalog().then((created) => {
        catalog = created;
        for (const listener of pendingChanged.splice(0)) created.onChanged(listener);
        for (const listener of pendingFailed.splice(0)) created.onRefreshFailed(listener);
        created.onChanged((event) => {
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
              handle: hadHandle ? handle : undefined,
              refresh: hadHandle ? shouldRefresh : undefined,
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
        () => [
          ready.value,
          config.value?.section(PROVIDERS_CONFIG_SECTION).value,
          config.value?.section(MODELS_CONFIG_SECTION).value,
          contributed.value,
          protocolFactories.value,
        ],
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
        bump();
      });

      const registered = new Map<string, { binding: CatalogModelBinding; withdraw: () => void }>();
      watch(
        () => [ready.value, snapshotRef.value] as const,
        () => {
          if (!ready.value) return;
          const next = new Map<string, CatalogModelBinding>();
          for (const providerId of face.providers()) {
            for (const model of face.models(providerId)) {
              const requester = face.requester(providerId, model.id);
              if (requester === undefined) continue;
              const info = face.providerInfo(providerId);
              next.set(`${providerId}:${model.id}`, {
                providerId,
                model,
                alias: catalogModelAlias(info, providerId, model.id),
                configKey: configKeys.get(providerId)?.get(model.id),
                requester,
              });
            }
          }
          for (const [key, slot] of registered) {
            if (next.get(key) === slot.binding) continue;
            slot.withdraw();
            registered.delete(key);
          }
          for (const [key, binding] of next) {
            if (!registered.has(key)) {
              registered.set(key, { binding, withdraw: node.register(CatalogModels, binding) });
            }
          }
        },
        { immediate: true },
      );
      onScopeDispose(() => {
        for (const slot of registered.values()) slot.withdraw();
        registered.clear();
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
      const bindings = useCollection(CatalogModels);
      const config = useInject(ConfigRef);
      const store = useFeatureStore('session', 'provider-catalog', sessionModelDefaultsProjection);
      const writer = featureWriterOf(harnessInternals(app), session.id);
      const mainAgentLog = () => writer.open<ModelBoundEvent>(`agents/${MAIN_AGENT_ID}/provider-catalog`);
      const mainBoundState = async () => {
        const log = await mainAgentLog();
        const view = log.replica.view(modelBindingProjection);
        const state = view.getState();
        view.dispose();
        return state;
      };
      const appDefaultAlias = (): string | undefined => {
        const value = config.value?.section<string>(DEFAULT_MODEL_CONFIG_SECTION).value;
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      };
      const dualWrite = async (patch: { alias?: string | null; thinking?: string | null }): Promise<void> => {
        const main = session.agents.get(MAIN_AGENT_ID);
        if (main === undefined) return;
        const current = await mainBoundState();
        const runningTurn = main.loop.state.turn?.id;
        const turnId = runningTurn ?? (await main.flush().then(() => main.view.getState().turns.at(-1)?.turnId));
        const log = await mainAgentLog();
        await log.commit({
          events: [
            {
              type: MODEL_BOUND,
              alias: patch.alias !== undefined ? patch.alias : current.alias,
              thinking: patch.thinking !== undefined ? patch.thinking : current.thinking,
              turnId,
            },
          ],
        });
      };
      useExpose(SessionModelRef, {
        setModel: async (alias) => {
          if (matchCatalogBinding(alias, bindings.value) === undefined) {
            throw new ModelCatalogError('model.unknown_alias', `Unknown model alias '${alias}'.`);
          }
          await store.dispatch([{ type: SESSION_MODEL_DEFAULTS, defaultModel: alias }]);
          await dualWrite({ alias });
        },
        setThinking: async (effort) => {
          const agentBound =
            session.agents.get(MAIN_AGENT_ID) === undefined ? undefined : await mainBoundState();
          const alias = agentBound?.alias ?? store.state.value.defaultModel ?? appDefaultAlias();
          const spec =
            alias === undefined ? undefined : matchCatalogBinding(alias, bindings.value)?.model;
          if (spec !== undefined) {
            const message = invalidThinkingEffortMessage(spec, effort);
            if (message !== undefined) {
              throw new ModelCatalogError('model.invalid_thinking', message);
            }
          }
          await dualWrite({ thinking: effort });
          await store.dispatch([{ type: SESSION_MODEL_DEFAULTS, defaultThinking: effort }]);
        },
      });
    },
    agent() {
      const runtime = useAgentRuntime();
      useLlmRecovery(credentialsRecovery);
      const config = useInject(ConfigRef);
      const bindings = useCollection(CatalogModels);
      const store = useFeatureStore('agent', 'provider-catalog', modelBindingProjection);
      const sessionStore = useFeatureStore('session', 'provider-catalog', sessionModelDefaultsProjection);
      let lastApplied: LoopLlmRequester | undefined;
      let lastSpec: LlmModelSpec | undefined;
      const effectiveAlias = (): string | undefined => {
        const value =
          store.state.value.alias ??
          sessionStore.state.value.defaultModel ??
          config.value?.section<string>(DEFAULT_MODEL_CONFIG_SECTION).value;
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      };
      const apply = (): boolean => {
        if (runtime.requester !== undefined && runtime.requester !== lastApplied) return false;
        const alias = effectiveAlias();
        if (alias === undefined) return true;
        const binding = matchCatalogBinding(alias, bindings.value);
        if (binding === undefined) return true;
        const thinkingSection = config.value?.section<ThinkingConfig>(THINKING_CONFIG_SECTION).value;
        const requested =
          store.state.value.thinking ??
          sessionStore.state.value.defaultThinking ??
          thinkingSection?.forcedEffort ??
          thinkingSection?.effort;
        const spec = binding.model;
        const next: LoopLlmRequester =
          requested === undefined
            ? binding.requester
            : binding.requester.with({
                model: { thinking: { effort: resolveThinkingEffortForModel(requested, spec) } },
              });
        runtime.requester = next;
        lastApplied = next;
        lastSpec = spec;
        return true;
      };
      useExpose(AgentModelRef, {
        current: store.state,
        setModel: async (alias) => {
          if (matchCatalogBinding(alias, bindings.value) === undefined) {
            throw new ModelCatalogError('model.unknown_alias', `Unknown model alias '${alias}'.`);
          }
          await store.dispatch([
            { type: MODEL_BOUND, alias, thinking: store.state.value.thinking },
          ]);
        },
        setThinking: async (effort) => {
          const alias = effectiveAlias();
          const spec =
            (alias === undefined ? undefined : matchCatalogBinding(alias, bindings.value)?.model) ??
            lastSpec;
          if (spec !== undefined) {
            const message = invalidThinkingEffortMessage(spec, effort);
            if (message !== undefined) {
              throw new ModelCatalogError('model.invalid_thinking', message);
            }
          }
          await store.dispatch([
            { type: MODEL_BOUND, alias: store.state.value.alias, thinking: effort },
          ]);
        },
      });
      onScopeDispose(() => {
        if (lastApplied !== undefined && runtime.requester === lastApplied) {
          runtime.requester = undefined;
        }
      });
      if (runtime.requester !== undefined) return;
      const stop = watch(
        () => [
          store.state.value,
          sessionStore.state.value,
          config.value,
          config.value?.section(DEFAULT_MODEL_CONFIG_SECTION).value,
          config.value?.section(THINKING_CONFIG_SECTION).value,
          bindings.value,
        ],
        () => {
          if (!apply()) stop();
        },
        { immediate: true },
      );
    },
  },
);

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
