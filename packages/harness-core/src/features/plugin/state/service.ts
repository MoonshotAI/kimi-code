import { shallowRef, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import type { McpServerConfig } from '#/features/mcp/core/config-schema';
import type { OsFsPort } from '#/features/os/host/index';
import type { CatalogProviderInfo } from '#/features/provider-catalog/index';
import { discoverSkills } from '#/features/skill/catalog/discovery';
import type { SkillRoot } from '#/features/skill/catalog/types';

import { PluginError } from '../errors';
import type { HookDef } from '../hooks';
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
} from '../types';

import { PluginManager } from './manager';
import {
  managedKimiCodeEnvForPlugins,
  withManagedKimiPluginEnv,
  withManagedKimiPluginEnvOnEntries,
} from './managed-env';

export interface PluginServiceDeps {
  readonly homeDir: string;
  readonly fs: OsFsPort;
  readonly warn?: (message: string) => void;
  readonly onReload?: (summary: ReloadSummary, mutation?: PluginMutation) => void | Promise<void>;
  readonly providerInfo?: (providerId: string) => CatalogProviderInfo | undefined;
}

export interface PluginService {
  readonly lastMutation: ShallowRef<PluginMutationSummary | null>;
  readonly lastReload: ShallowRef<ReloadSummary | null>;
  listPlugins(): Promise<readonly PluginSummary[]>;
  installPlugin(source: string): Promise<PluginSummary>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
  removePlugin(id: string): Promise<void>;
  reloadPlugins(): Promise<ReloadSummary>;
  getPluginInfo(id: string): Promise<PluginInfo>;
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  pluginSkillRoots(): Promise<readonly SkillRoot[]>;
  pluginAgentRoots(): Promise<readonly PluginAgentRoot[]>;
  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]>;
  enabledSystemPrompts(): Promise<readonly EnabledPluginSystemPrompt[]>;
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  mcpServerEntries(): Promise<readonly PluginMcpServerEntry[]>;
  enabledHooks(): Promise<readonly HookDef[]>;
  hasLoadedSnapshot(): boolean;
  skillRootsNow(): readonly SkillRoot[];
}

export function createPluginService(deps: PluginServiceDeps): PluginService {
  const manager = new PluginManager({
    homeDir: deps.homeDir,
    fs: deps.fs,
    discoverSkills: (roots) => discoverSkills(deps.fs, roots, deps.warn),
  });
  let initialLoadPromise: Promise<void> | undefined;
  let snapshotLoaded = false;
  let loadError: Error | undefined;
  let mutationQueue: Promise<void> = Promise.resolve();
  const lastMutation = shallowRef<PluginMutationSummary | null>(null);
  const lastReload = shallowRef<ReloadSummary | null>(null);

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const loadOnce = async (): Promise<void> => {
    try {
      await manager.load();
      snapshotLoaded = true;
      loadError = undefined;
    } catch (error) {
      loadError = error instanceof Error ? error : new Error(String(error));
    }
  };

  const startInitialLoad = (): Promise<void> => {
    initialLoadPromise ??= enqueueMutation(loadOnce);
    return initialLoadPromise;
  };

  const assertLoaded = (): void => {
    if (loadError === undefined) return;
    throw new PluginError(
      'plugin.load_failed',
      `Plugin state failed to load: ${loadError.message}. ` +
        `Fix the file at ${deps.homeDir}/plugins/installed.json and run /plugins reload.`,
      { cause: loadError, details: { homeDir: deps.homeDir } },
    );
  };

  const waitForPendingMutations = async (): Promise<void> => {
    void startInitialLoad();
    await mutationQueue;
  };

  const managedEnv = (): Record<string, string> =>
    managedKimiCodeEnvForPlugins(deps.providerInfo ?? (() => undefined));

  const reloadAndNotify = async (mutation?: PluginMutation): Promise<ReloadSummary> => {
    const summary = await manager.reload();
    snapshotLoaded = true;
    loadError = undefined;
    if (mutation !== undefined) lastMutation.value = { ...summary, mutation };
    lastReload.value = summary;
    await deps.onReload?.(summary, mutation);
    return summary;
  };

  const runSerializedOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    void startInitialLoad();
    return enqueueMutation(async () => {
      assertLoaded();
      return operation();
    });
  };

  const runManagementRead = async <T>(operation: () => Promise<T>): Promise<T> => {
    await waitForPendingMutations();
    assertLoaded();
    return operation();
  };

  const runConsumptionRead = async <T>(
    fallback: T,
    operation: () => Promise<T>,
  ): Promise<T> => {
    await waitForPendingMutations();
    if (!snapshotLoaded) return fallback;
    return operation();
  };

  return {
    lastMutation,
    lastReload,
    listPlugins: () => runManagementRead(async () => manager.summaries()),
    installPlugin: (source) =>
      runSerializedOperation(async () => {
        const record = await manager.install(source);
        const info = manager.info(record.id);
        if (info === undefined) {
          throw new PluginError(
            'plugin.load_failed',
            `Plugin "${record.id}" missing right after install`,
            { details: { id: record.id } },
          );
        }
        await reloadAndNotify({ kind: 'install', id: record.id });
        return info;
      }),
    setPluginEnabled: (id, enabled) =>
      runSerializedOperation(async () => {
        await manager.setEnabled(id, enabled);
        await reloadAndNotify({ kind: enabled ? 'enable' : 'disable', id });
      }),
    setPluginMcpServerEnabled: (id, server, enabled) =>
      runSerializedOperation(async () => {
        await manager.setMcpServerEnabled(id, server, enabled);
        await reloadAndNotify({ kind: 'mcp-server', id });
      }),
    removePlugin: (id) =>
      runSerializedOperation(async () => {
        await manager.remove(id);
        await reloadAndNotify({ kind: 'remove', id });
      }),
    reloadPlugins: () => {
      const reload = enqueueMutation(async () => {
        try {
          return await reloadAndNotify();
        } catch (error) {
          loadError = error instanceof Error ? error : new Error(String(error));
          throw new PluginError('plugin.load_failed', `Failed to reload plugins: ${loadError.message}`, {
            cause: loadError,
            details: { homeDir: deps.homeDir },
          });
        }
      });
      initialLoadPromise ??= reload.then(
        () => undefined,
        () => undefined,
      );
      return reload;
    },
    getPluginInfo: (id) =>
      runManagementRead(async () => {
        const info = manager.info(id);
        if (info === undefined) {
          throw new PluginError('plugin.not_found', `Plugin "${id}" is not installed`, {
            details: { id },
          });
        }
        return info;
      }),
    listPluginCommands: () => runSerializedOperation(async () => manager.enabledCommands()),
    checkUpdates: () => runManagementRead(async () => manager.checkUpdates()),
    pluginSkillRoots: () => runConsumptionRead([], async () => manager.pluginSkillRoots()),
    pluginAgentRoots: () => runConsumptionRead([], async () => manager.pluginAgentRoots()),
    enabledSessionStarts: () => runConsumptionRead([], async () => manager.enabledSessionStarts()),
    enabledSystemPrompts: () =>
      runConsumptionRead([], async () => manager.enabledSystemPrompts()),
    enabledMcpServers: () =>
      runConsumptionRead({}, async () => {
        const pluginServers = manager.enabledMcpServers();
        if (!Object.values(pluginServers).some((server) => server.transport === 'stdio')) {
          return pluginServers;
        }
        return withManagedKimiPluginEnv(pluginServers, managedEnv());
      }),
    mcpServerEntries: () =>
      runManagementRead(async () => {
        const entries = manager.mcpServerEntries();
        if (!entries.some((entry) => entry.config.transport === 'stdio')) return entries;
        return withManagedKimiPluginEnvOnEntries(entries, managedEnv());
      }),
    enabledHooks: () => runConsumptionRead([], async () => manager.enabledHooks()),
    hasLoadedSnapshot: () => snapshotLoaded,
    skillRootsNow: () => manager.pluginSkillRoots(),
  };
}
