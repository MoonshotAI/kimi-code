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
  useFire,
  useInject,
  watch,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit } from '@moonshot-ai/agent-core/kernel/runtime';
import { createProviderCatalog } from '@moonshot-ai/agent-core/llm/catalog/index';
import type {
  CatalogModel,
  CatalogProviderHandle,
  CatalogSnapshot,
  ProviderCatalog,
  ProviderCatalogChangedEvent,
  ProviderCatalogPingResult,
  ProviderCatalogRefreshFailedEvent,
} from '@moonshot-ai/agent-core/llm/catalog/index';
import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '@moonshot-ai/agent-core/llm/builtin/provider/index';
import { createStaticCredentialProvider, credentialsRecovery } from '@moonshot-ai/agent-core/llm/builtin/policy/credentials';
import type { LlmModelSpec } from '@moonshot-ai/agent-core/llm/request';
import type { LlmRequester } from '@moonshot-ai/agent-core/llm/requester';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import {
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  DEFAULT_PROVIDER_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  THINKING_CONFIG_SECTION,
  deepEqual,
  describeUnknownError,
  defaultModelConfigSection,
  defaultProviderConfigSection,
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
import {
  CredentialResolvers,
  resolveCredentialProvider,
  useCredentialResolver,
  type CredentialResolverContribution,
} from './credentials';
import { MODEL_OVERRIDES_CONFIG_SECTION, kimiModelEnvOverlay } from './envOverlay';
import {
  createRefreshOrchestrator,
  ProviderOAuthTokenResolvers,
  ProviderRefreshUserAgents,
  type ModelCatalogChangedEvent,
  type ProviderRefreshOptions,
  type ProviderRefreshReport,
  type RetiredModel,
} from './refresh';
import {
  invalidThinkingEffortMessage,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
} from './thinking';
import {
  catalogModelAlias,
  catalogModelDefinitionOf,
  catalogProviderIdOf,
  type AddProviderInput,
  type CatalogModelBinding,
  type CatalogModelConfig,
  type CatalogProviderInfo,
  type ProviderContribution,
  type ProviderRefreshContribution,
} from './types';

export const Providers = createCollection<ProviderContribution>('provider-catalog.providers');

export const CatalogModels = createCollection<CatalogModelBinding>('provider-catalog.models');

export const ProviderRefreshers = createCollection<ProviderRefreshContribution>(
  'provider-catalog.refreshers',
);

export function useProviderRefresh(
  contribution: ProviderRefreshContribution,
  priority = 0,
): void {
  useContribute(ProviderRefreshers, contribution, priority);
}

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
  providers(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  models(providerId: string): readonly CatalogModel[];
  model(providerId: string, modelId: string): CatalogModel | undefined;
  findByName(name: string): readonly string[];
  requester(providerId: string, modelId: string): LlmRequester<'protocol' | 'model'> | undefined;
  isLive(providerId: string): boolean;
  addProvider(input: AddProviderInput): Promise<void>;
  addModel(key: string, record: CatalogModelConfig): Promise<void>;
  refresh(options?: ProviderRefreshOptions): Promise<ProviderRefreshReport>;
  retiredModelReplacement(alias: string): string | undefined;
  ping(providerId: string, modelId: string): Promise<ProviderCatalogPingResult>;
  onChanged(listener: (event: ProviderCatalogChangedEvent) => void): () => void;
  onRefreshFailed(listener: (event: ProviderCatalogRefreshFailedEvent) => void): () => void;
  onRetiredModel(listener: (event: RetiredModel) => void): () => void;
}

export const ProviderCatalogRef = createFacadeToken<ProviderCatalogFace>('provider-catalog');

export function useProvider(contribution: ProviderContribution, priority = 0): void {
  useContribute(Providers, contribution, priority);
}

export function useProviderCatalog(): Readonly<ShallowRef<ProviderCatalogFace | undefined>> {
  return useInject(ProviderCatalogRef);
}

const STATIC_CREDENTIAL_RESOLVER_PRIORITY = 1000;

interface ModelOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
}

function requesterEntries(
  info: CatalogProviderInfo,
  contributions: readonly ProviderProtocolContribution[],
): Record<string, LlmRequester<'protocol'>> {
  const factory = contributions.findLast((contribution) => contribution.type === info.type);
  if (factory === undefined) return {};
  return Object.fromEntries(
    Object.entries(factory.protocols(info)).filter(
      (entry): entry is [string, LlmRequester<'protocol'>] => entry[1] !== undefined,
    ),
  );
}

function materializeProvider(
  providerId: string,
  info: CatalogProviderInfo | undefined,
  records: Readonly<Record<string, CatalogModelConfig>>,
  contributions: readonly ProviderProtocolContribution[],
): CatalogProviderHandle | undefined {
  const requester = info?.type === undefined ? {} : requesterEntries(info, contributions);
  for (const record of Object.values(records)) {
    if (record.protocol === undefined) continue;
    Object.assign(
      requester,
      requesterEntries(
        {
          ...info,
          type: record.protocol,
          baseUrl: record.baseUrl ?? info?.baseUrl,
          customHeaders: record.defaultHeaders ?? info?.customHeaders,
          apiKey: record.apiKey ?? info?.apiKey,
        },
        contributions,
      ),
    );
  }
  return Object.keys(requester).length === 0 ? undefined : { id: providerId, requester };
}

function mergeProviderInfo(
  init: CatalogProviderInfo | undefined,
  configured: CatalogProviderInfo | undefined,
): CatalogProviderInfo | undefined {
  if (init === undefined) return configured;
  if (configured === undefined) return init;
  return {
    ...init,
    ...configured,
    customHeaders:
      init.customHeaders === undefined && configured.customHeaders === undefined
        ? undefined
        : { ...init.customHeaders, ...configured.customHeaders },
    env:
      init.env === undefined && configured.env === undefined
        ? undefined
        : { ...init.env, ...configured.env },
  };
}

export const providerCatalog = createFeature<
  ModelBoundEvent | SessionModelDefaultsEvent | ModelCatalogChangedEvent
>(
  'provider-catalog',
  {
    app() {
      const node = currentUnit();
      const fire = useFire();
      useProviderProtocol({
        type: 'openai',
        protocols: () => ({ openai: openAIRequester, openai_responses: openAIResponsesRequester }),
      });
      useProviderProtocol({
        type: 'openai_responses',
        protocols: () => ({ openai_responses: openAIResponsesRequester }),
      });
      useProviderProtocol({ type: 'anthropic', protocols: () => ({ anthropic: anthropicRequester }) });
      useProviderProtocol({
        type: 'google-genai',
        protocols: () => ({ 'google-genai': googleGenAIRequester }),
      });
      useProviderProtocol({
        type: 'vertexai',
        protocols: () => ({ 'google-genai': googleVertexRequester }),
      });
      const live = new Set<string>();
      const configKeys = new Map<string, Map<string, string>>();
      const requesterErrors = new Map<string, Map<string, unknown>>();
      const addedProviders = new Set<() => void>();
      const failedListeners = new Set<(event: ProviderCatalogRefreshFailedEvent) => void>();
      const retiredListeners = new Set<(event: RetiredModel) => void>();
      let catalog: ProviderCatalog | undefined;
      const ready = shallowRef(false);
      const snapshotRef = shallowRef<CatalogSnapshot>({ providers: {} });
      const pendingChanged: ((event: ProviderCatalogChangedEvent) => void)[] = [];
      const face: ProviderCatalogFace = {
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
        findByName: (name) => {
          const keys: string[] = [];
          for (const entry of projected.values()) {
            for (const [configKey, record] of Object.entries(entry.records)) {
              if (record.name === name || record.model === name || record.aliases?.includes(name)) {
                keys.push(configKey);
              }
            }
          }
          return keys;
        },
        requester: (providerId, modelId) => {
          const error = requesterErrors.get(providerId)?.get(modelId);
          if (error !== undefined) {
            throw error instanceof Error ? error : new Error(describeUnknownError(error));
          }
          return catalog === undefined ? undefined : catalog.requester(providerId, modelId);
        },
        isLive: (providerId) => live.has(providerId),
        addProvider: async ({ handle, init }) => {
          const withdraw = node.register(Providers, { handle, info: init });
          addedProviders.add(withdraw);
          try {
            if (init !== undefined && config.value !== undefined) {
              const current = config.value;
              const providers = current.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {};
              if (providers[handle.id] === undefined) {
                await current.set(PROVIDERS_CONFIG_SECTION, { [handle.id]: init }, 'user');
              }
            }
          } catch (error) {
            addedProviders.delete(withdraw);
            withdraw();
            throw error;
          }
        },
        addModel: (key, record) => orchestrator.addModel(key, record),
        refresh: (options = {}) => orchestrator.refresh(options),
        retiredModelReplacement: (alias) => orchestrator.retiredModelReplacement(alias),
        ping: async (providerId, modelId) => {
          const cat = catalog;
          if (cat === undefined) throw new Error('Provider catalog is not ready');
          face.requester(providerId, modelId);
          return cat.ping(providerId, modelId);
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
          failedListeners.add(listener);
          return () => {
            failedListeners.delete(listener);
          };
        },
        onRetiredModel: (listener) => {
          retiredListeners.add(listener);
          return () => {
            retiredListeners.delete(listener);
          };
        },
      };
      useExpose(ProviderCatalogRef, face);

      const config = useInject(ConfigRef);
      void createProviderCatalog().then((created) => {
        catalog = created;
        created.onChanged(() => {
          snapshotRef.value = created.snapshot();
        });
        for (const listener of pendingChanged.splice(0)) created.onChanged(listener);
        ready.value = true;
      });
      useCleanup(() => {
        catalog?.close();
        for (const withdraw of addedProviders) withdraw();
        addedProviders.clear();
        failedListeners.clear();
        retiredListeners.clear();
      });

      const contributed = useCollection(Providers);
      const protocolFactories = useCollection(ProviderProtocols);
      const refreshers = useCollection(ProviderRefreshers);
      const bindings = useCollection(CatalogModels);
      const resolvers = useCollection(CredentialResolvers);
      const oauthTokenResolvers = useCollection(ProviderOAuthTokenResolvers);
      const refreshUserAgents = useCollection(ProviderRefreshUserAgents);
      const orchestrator = createRefreshOrchestrator({
        config: () => config.value,
        providerIds: () => face.providers(),
        providerInfo: (providerId) => face.providerInfo(providerId),
        refreshers: () => refreshers.value,
        tokenResolvers: () => oauthTokenResolvers.value,
        userAgents: () => refreshUserAgents.value,
        onChanged: (report) => {
          fire({ type: 'event.model_catalog.changed', payload: report });
        },
        onFailed: (providerId, error) => {
          const event = { type: 'refresh-failed', providerId, error } as const;
          for (const listener of failedListeners) listener(event);
        },
        onRetired: (event) => {
          for (const listener of retiredListeners) listener(event);
        },
      });
      useConfigSection(providersConfigSection);
      useConfigSection(modelsConfigSection);
      useConfigSection(thinkingConfigSection);
      useConfigSection(modelCatalogConfigSection);
      useConfigSection(defaultModelConfigSection);
      useConfigSection(defaultProviderConfigSection);
      useConfigOverlay(kimiModelEnvOverlay);
      useCredentialResolver(
        {
          resolve: (info) => {
            const apiKey = resolveProviderInfo(info)?.apiKey;
            return apiKey === undefined ? undefined : createStaticCredentialProvider(apiKey);
          },
        },
        STATIC_CREDENTIAL_RESOLVER_PRIORITY,
      );

      const projected = new Map<
        string,
        {
          info: CatalogProviderInfo | undefined;
          records: Record<string, CatalogModelConfig>;
          contributionHandle: CatalogProviderHandle | undefined;
          factories: readonly ProviderProtocolContribution[];
          resolvers: readonly CredentialResolverContribution[];
          config: ConfigStore | undefined;
        }
      >();
      const reconcile = (): void => {
        const cat = catalog;
        if (!ready.value || cat === undefined) return;
        const current = config.value;
        const providersSection = current?.section<ProvidersSection>(PROVIDERS_CONFIG_SECTION).value ?? {};
        const modelsSection = current?.section<ModelsSection>(MODELS_CONFIG_SECTION).value ?? {};
        const defaultProvider = current?.section<string>(DEFAULT_PROVIDER_CONFIG_SECTION).value;
        const contributions = new Map(contributed.value.map((item) => [item.handle.id, item]));
        const normalized = Object.entries(modelsSection).map(([configKey, record]) => ({
          configKey,
          record,
          providerId: catalogProviderIdOf(record, defaultProvider),
        }));
        const ids = new Set<string>([
          ...projected.keys(),
          ...contributions.keys(),
          ...Object.keys(providersSection),
          ...normalized.map((entry) => entry.providerId),
        ]);
        for (const providerId of ids) {
          const contribution = contributions.get(providerId);
          const configured = providersSection[providerId];
          const info = resolveProviderInfo(mergeProviderInfo(contribution?.info, configured));
          const prefix = `${providerId}/`;
          const records = Object.fromEntries(
            normalized
              .filter((entry) => entry.providerId === providerId)
              .toSorted(
                (a, b) =>
                  Number(b.configKey.startsWith(prefix)) - Number(a.configKey.startsWith(prefix)),
              )
              .map((entry) => [entry.configKey, entry.record]),
          ) as Record<string, CatalogModelConfig>;
          if (
            contribution === undefined &&
            configured === undefined &&
            Object.keys(records).length === 0
          ) {
            cat.remove(providerId);
            live.delete(providerId);
            configKeys.delete(providerId);
            requesterErrors.delete(providerId);
            projected.delete(providerId);
            continue;
          }
          const previous = projected.get(providerId);
          if (
            previous !== undefined &&
            previous.contributionHandle === contribution?.handle &&
            previous.factories === protocolFactories.value &&
            previous.resolvers === resolvers.value &&
            previous.config === current &&
            deepEqual(previous.info, info) &&
            deepEqual(previous.records, records)
          ) {
            continue;
          }
          const handle =
            contribution?.handle ??
            materializeProvider(providerId, info, records, protocolFactories.value);
          if (handle === undefined && live.has(providerId)) {
            cat.remove(providerId);
          }
          if (handle === undefined) {
            live.delete(providerId);
          } else {
            live.add(providerId);
          }
          configKeys.set(
            providerId,
            new Map(
              Object.entries(records).map(([key, record]) => [record.model ?? key, key]),
            ),
          );
          const errors = new Map<string, unknown>();
          const definitions = Object.entries(records).map(([configKey, record]) => {
            try {
              return catalogModelDefinitionOf(configKey, record, {
                providerId,
                provider: info,
                config: current,
                resolveCredential: (candidate) =>
                  resolveCredentialProvider(candidate, resolvers.value),
              });
            } catch (error) {
              errors.set(record.model ?? configKey, error);
              return {
                ...catalogModelDefinitionOf(configKey, record),
                provider: providerId,
              };
            }
          });
          requesterErrors.set(providerId, errors);
          cat.upsert({
            providerId,
            handle,
            info,
            models: definitions,
            refresh: false,
          });
          projected.set(providerId, {
            info,
            records,
            contributionHandle: contribution?.handle,
            factories: protocolFactories.value,
            resolvers: resolvers.value,
            config: current,
          });
        }
      };
      watch(
        () => [
          ready.value,
          config.value?.section(PROVIDERS_CONFIG_SECTION).value,
          config.value?.section(MODELS_CONFIG_SECTION).value,
          config.value?.section(DEFAULT_PROVIDER_CONFIG_SECTION).value,
          contributed.value,
          protocolFactories.value,
          resolvers.value,
        ],
        reconcile,
        { immediate: true, scheduler: coalescedMicrotaskScheduler() },
      );

      const registered = new Map<string, { binding: CatalogModelBinding; withdraw: () => void }>();
      watch(
        () => [ready.value, snapshotRef.value] as const,
        () => {
          if (!ready.value) return;
          const next = new Map<string, CatalogModelBinding>();
          for (const providerId of face.providers()) {
            for (const model of face.models(providerId)) {
              let requester: LlmRequester<'protocol' | 'model'> | undefined;
              try {
                requester = face.requester(providerId, model.id);
              } catch {
                continue;
              }
              if (requester === undefined) continue;
              next.set(`${providerId}:${model.id}`, {
                providerId,
                model,
                alias: catalogModelAlias(providerId, model.id),
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
        const overrides = config.value?.section<ModelOverrides>(MODEL_OVERRIDES_CONFIG_SECTION).value;
        const requested =
          store.state.value.thinking ??
          sessionStore.state.value.defaultThinking ??
          thinkingSection?.forcedEffort ??
          thinkingSection?.effort;
        const spec = binding.model;
        const effort = resolveThinkingEffortForModel(
          requested ?? spec.defaultThinking?.effort,
          spec,
        );
        const keep = resolveThinkingKeep(overrides?.thinkingKeep, thinkingSection?.keep, effort);
        let next: LoopLlmRequester = binding.requester;
        if (requested !== undefined || keep !== undefined) {
          next = next.with({ model: { thinking: { effort, keep } } });
        }
        if (overrides?.temperature !== undefined || overrides?.topP !== undefined) {
          next = next.with({
            model: {
              sampling: { temperature: overrides.temperature, topP: overrides.topP },
            },
          });
        }
        if (overrides?.maxCompletionTokens !== undefined) {
          next = next.with({
            model: {
              maxOutputTokens:
                overrides.maxCompletionTokens > 0 ? overrides.maxCompletionTokens : 'none',
            },
          });
        }
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
          config.value?.section(MODEL_OVERRIDES_CONFIG_SECTION).value,
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
): CatalogProviderInfo | undefined {
  return info;
}
