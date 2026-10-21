import {
  createFeature,
  useAgent,
  useSession,
  useStepStarting,
  type Feature,
} from '#/app/index';
import { shallowRef, useCleanup, useExpose, useFire, useInject } from '#/kernel/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import type { McpServerConfig } from '#/features/mcp/core/config-schema';
import { useMcpServerSource } from '#/features/mcp/config/sources';
import { ProviderCatalogRef } from '#/features/provider-catalog/index';
import { discoverSkills } from '#/features/skill/catalog/discovery';
import type { SkillRoot } from '#/features/skill/catalog/types';
import { SkillCatalogRef, useSkillSource } from '#/features/skill/index';
import { useFeatureStore } from '#/runtime/index';

import { createPluginSessionStartReminder, pluginSessionStartProjection } from './agent/session-start';
import { createPluginMcpSource } from './contribute/mcp';
import { createPluginSkillSource } from './contribute/skills';
import { PluginError } from './errors';
import { PluginRef, type CreatePluginProps, type PluginEvent, type PluginFace } from './face';
import { PLUGIN_HOOK_SOURCE_ID, type HookDef } from './hooks';
import {
  managedKimiCodeEnvForPlugins,
  withManagedKimiPluginEnv,
  withManagedKimiPluginEnvOnEntries,
} from './state/managed-env';
import { PluginManager } from './state/manager';
import type {
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
  PluginAgentRoot,
  PluginCommandDef,
  PluginInfo,
  PluginMcpServerEntry,
  PluginMutation,
  PluginMutationSummary,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

export function createPlugin(props: CreatePluginProps): Feature<void, { app: PluginEvent }> {
  return createFeature<{ app: PluginEvent }>('plugin', {
    app() {
      const host = props.host;
      if (host === undefined) return;
      const fire = useFire();
      const providerCatalog = useInject(ProviderCatalogRef);
      const changeListeners = new Set<() => void>();
      const onDidChange = (listener: () => void): (() => void) => {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      };
      const manager = new PluginManager({
        homeDir: props.homeDir,
        fs: host.fs,
        discoverSkills: (roots) => discoverSkills(host.fs, roots, props.onWarn),
      });
      let initialLoadPromise: Promise<void> | undefined;
      let snapshotLoaded = false;
      let loadError: Error | undefined;
      let mutationQueue: Promise<void> = Promise.resolve();
      const lastMutation = shallowRef<PluginMutationSummary | null>(null);
      const lastReload = shallowRef<ReloadSummary | null>(null);

      const _enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = mutationQueue.then(operation);
        mutationQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };

      const _loadOnce = async (): Promise<void> => {
        try {
          await manager.load();
          snapshotLoaded = true;
          loadError = undefined;
        } catch (error) {
          loadError = error instanceof Error ? error : new Error(String(error));
        }
      };

      const _startInitialLoad = (): Promise<void> => {
        initialLoadPromise ??= _enqueueMutation(_loadOnce);
        return initialLoadPromise;
      };

      const _assertLoaded = (): void => {
        if (loadError === undefined) return;
        throw new PluginError(
          'plugin.load_failed',
          `Plugin state failed to load: ${loadError.message}. ` +
            `Fix the file at ${props.homeDir}/plugins/installed.json and run /plugins reload.`,
          { cause: loadError, details: { homeDir: props.homeDir } },
        );
      };

      const _waitForPendingMutations = async (): Promise<void> => {
        void _startInitialLoad();
        await mutationQueue;
      };

      const _managedEnv = (): Record<string, string> =>
        managedKimiCodeEnvForPlugins((providerId) => providerCatalog.value?.providerInfo(providerId));

      let refreshSkillIndex: () => Promise<void> = () => Promise.resolve();

      const _reloadAndNotify = async (mutation?: PluginMutation): Promise<ReloadSummary> => {
        const summary = await manager.reload();
        snapshotLoaded = true;
        loadError = undefined;
        if (mutation !== undefined) lastMutation.value = { ...summary, mutation };
        lastReload.value = summary;
        fire({ type: 'plugin.changed', summary });
        await refreshSkillIndex();
        for (const listener of changeListeners) listener();
        if (mutation !== undefined) {
          fire({ type: 'plugin.mutated', summary: { ...summary, mutation } });
        }
        return summary;
      };

      const _runSerializedOperation = <T>(operation: () => Promise<T>): Promise<T> => {
        void _startInitialLoad();
        return _enqueueMutation(async () => {
          _assertLoaded();
          return operation();
        });
      };

      const _runManagementRead = async <T>(operation: () => Promise<T>): Promise<T> => {
        await _waitForPendingMutations();
        _assertLoaded();
        return operation();
      };

      const _runConsumptionRead = async <T>(
        fallback: T,
        operation: () => Promise<T>,
      ): Promise<T> => {
        await _waitForPendingMutations();
        if (!snapshotLoaded) return fallback;
        return operation();
      };

      const listPlugins = (): Promise<readonly PluginSummary[]> =>
        _runManagementRead(async () => manager.summaries());

      const installPlugin = (source: string): Promise<PluginSummary> =>
        _runSerializedOperation(async () => {
          const record = await manager.install(source);
          const info = manager.info(record.id);
          if (info === undefined) {
            throw new PluginError(
              'plugin.load_failed',
              `Plugin "${record.id}" missing right after install`,
              { details: { id: record.id } },
            );
          }
          await _reloadAndNotify({ kind: 'install', id: record.id });
          return info;
        });

      const setPluginEnabled = (id: string, enabled: boolean): Promise<void> =>
        _runSerializedOperation(async () => {
          await manager.setEnabled(id, enabled);
          await _reloadAndNotify({ kind: enabled ? 'enable' : 'disable', id });
        });

      const setPluginMcpServerEnabled = (id: string, server: string, enabled: boolean): Promise<void> =>
        _runSerializedOperation(async () => {
          await manager.setMcpServerEnabled(id, server, enabled);
          await _reloadAndNotify({ kind: 'mcp-server', id });
        });

      const removePlugin = (id: string): Promise<void> =>
        _runSerializedOperation(async () => {
          await manager.remove(id);
          await _reloadAndNotify({ kind: 'remove', id });
        });

      const reloadPlugins = (): Promise<ReloadSummary> => {
        const reload = _enqueueMutation(async () => {
          try {
            return await _reloadAndNotify();
          } catch (error) {
            loadError = error instanceof Error ? error : new Error(String(error));
            throw new PluginError('plugin.load_failed', `Failed to reload plugins: ${loadError.message}`, {
              cause: loadError,
              details: { homeDir: props.homeDir },
            });
          }
        });
        initialLoadPromise ??= reload.then(
          () => undefined,
          () => undefined,
        );
        return reload;
      };

      const getPluginInfo = (id: string): Promise<PluginInfo> =>
        _runManagementRead(async () => {
          const info = manager.info(id);
          if (info === undefined) {
            throw new PluginError('plugin.not_found', `Plugin "${id}" is not installed`, {
              details: { id },
            });
          }
          return info;
        });

      const listPluginCommands = (): Promise<readonly PluginCommandDef[]> =>
        _runSerializedOperation(async () => manager.enabledCommands());

      const checkUpdates = (): Promise<readonly PluginUpdateStatus[]> =>
        _runManagementRead(async () => manager.checkUpdates());

      const pluginSkillRoots = (): Promise<readonly SkillRoot[]> =>
        _runConsumptionRead([], async () => manager.pluginSkillRoots());

      const pluginAgentRoots = (): Promise<readonly PluginAgentRoot[]> =>
        _runConsumptionRead([], async () => manager.pluginAgentRoots());

      const enabledSessionStarts = (): Promise<readonly EnabledPluginSessionStart[]> =>
        _runConsumptionRead([], async () => manager.enabledSessionStarts());

      const enabledSystemPrompts = (): Promise<readonly EnabledPluginSystemPrompt[]> =>
        _runConsumptionRead([], async () => manager.enabledSystemPrompts());

      const enabledMcpServers = (): Promise<Record<string, McpServerConfig>> =>
        _runConsumptionRead({}, async () => {
          const pluginServers = manager.enabledMcpServers();
          if (!Object.values(pluginServers).some((server) => server.transport === 'stdio')) {
            return pluginServers;
          }
          return withManagedKimiPluginEnv(pluginServers, _managedEnv());
        });

      const mcpServerEntries = (): Promise<readonly PluginMcpServerEntry[]> =>
        _runManagementRead(async () => {
          const entries = manager.mcpServerEntries();
          if (!entries.some((entry) => entry.config.transport === 'stdio')) return entries;
          return withManagedKimiPluginEnvOnEntries(entries, _managedEnv());
        });

      const enabledHooks = (): Promise<readonly HookDef[]> =>
        _runConsumptionRead([], async () => manager.enabledHooks());

      const hasLoadedSnapshot = (): boolean => snapshotLoaded;

      const _skillRootsNow = (): readonly SkillRoot[] => manager.pluginSkillRoots();

      const skillSource = createPluginSkillSource({
        fs: host.fs,
        roots: () => pluginSkillRoots(),
        warn: props.onWarn,
        onDidChange,
      });
      refreshSkillIndex = async () => {
        await skillSource.refresh(_skillRootsNow()).catch(() => undefined);
      };
      useSkillSource(skillSource.source);
      useMcpServerSource(
        createPluginMcpSource({
          servers: () => enabledMcpServers(),
          onDidChange,
        }),
      );
      const releaseHookSource = props.useHookSource?.({
        id: PLUGIN_HOOK_SOURCE_ID,
        load: () => enabledHooks(),
        onDidChange,
      });
      if (releaseHookSource !== undefined) useCleanup(releaseHookSource);
      useExpose(PluginRef, {
        lastMutation,
        lastReload,
        listPlugins,
        installPlugin,
        setPluginEnabled,
        setPluginMcpServerEnabled,
        removePlugin,
        reloadPlugins,
        getPluginInfo,
        listPluginCommands,
        checkUpdates,
        pluginSkillRoots,
        pluginAgentRoots,
        enabledSessionStarts,
        enabledSystemPrompts,
        enabledMcpServers,
        mcpServerEntries,
        enabledHooks,
        hasLoadedSnapshot,
        getPluginSkill: (pluginId, name) => skillSource.getPluginSkill(pluginId, name),
      } satisfies PluginFace);
    },
    agent() {
      if (props.host === undefined) return;
      const agent = useAgent();
      if (agent.id !== MAIN_AGENT_ID) return;
      const face = useInject(PluginRef).value;
      if (face === undefined) return;
      const skillCatalog = useInject(SkillCatalogRef);
      const store = useFeatureStore('agent', 'plugin-session-start', pluginSessionStartProjection);
      useStepStarting(
        createPluginSessionStartReminder({
          agent,
          store,
          sessionId: useSession().id,
          face,
          catalog: () => skillCatalog.value,
          warn: props.onWarn,
        }),
        { id: 'plugin.session-start' },
      );
    },
  });
}
