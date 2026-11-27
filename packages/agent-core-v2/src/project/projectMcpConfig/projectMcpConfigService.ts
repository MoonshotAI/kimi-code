import { dirname } from 'pathe';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  loadMcpConfigLayers,
  mergeMcpServerEntries,
  resolveMcpJsonPaths,
} from '#/app/mcpConfig/configLoader';
import { MCP_SECTION, mcpTunablesFromSection, type McpSection } from '#/app/mcpConfig/configSection';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginMcpServerEntry } from '#/app/plugin/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpServerConfigEntry } from '#/mcpCore/config-override';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { mcpOAuthStoreKey } from '#/mcpCore/oauth/store';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IProjectTrust } from '#/project/projectTrust/projectTrust';
import { watch, watchCandidates } from '#human/utils/watch';

import {
  IProjectMcpConfigService,
  MCP_PROJECT_SOURCE_IDS,
  type McpDirs,
  type McpProjectSourceId,
  type McpServersChangeEvent,
  type McpSourceServersChangeEvent,
  type McpTunables,
} from './projectMcpConfig';

const WATCH_DEBOUNCE_MS = 200;

type SourceEntriesMap = Record<McpProjectSourceId, Record<string, McpServerConfigEntry>>;

function emptySourceEntries(): SourceEntriesMap {
  return { plugin: {}, user: {}, 'project-root': {}, workspace: {} };
}

export class ProjectMcpConfigService extends Disposable implements IProjectMcpConfigService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private layers: SourceEntriesMap = emptySourceEntries();
  private pluginServers = new Map<string, McpServerConfig>();
  private disabledOAuthServers = new Map<string, McpServerConfig>();
  private disposed = false;
  private current: Readonly<Record<string, McpServerConfig>> = {};
  private untrustedOAuthServers: Readonly<Record<string, McpServerConfig>> | undefined;
  private initializationComplete = false;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly changeEmitter = this._register(new AsyncEmitter<McpServersChangeEvent>());
  private readonly sourceChangeEmitter = this._register(
    new AsyncEmitter<McpSourceServersChangeEvent>(),
  );
  private readonly tunablesEmitter = this._register(new Emitter<McpTunables>());
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeSource = this.sourceChangeEmitter.event;
  readonly onDidChangeTunables = this.tunablesEmitter.event;
  private projectWatcher?: IDisposable;
  private watchedPrimary?: string;
  private primaryReloadTail: Promise<void> = Promise.resolve();

  constructor(
    @IProjectDirs private readonly dirs: McpDirs,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginService private readonly plugins: IPluginService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IProjectTrust private readonly trust: IProjectTrust,
    @IMcpConfigStore mcpConfigStore: IMcpConfigStore,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
  ) {
    super();
    this.oauth.setConfigurationSource(this, []);
    this._register({
      dispose: () => {
        this.disposed = true;
        this.oauth.removeConfigurationSource(this);
      },
    });
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp config initial load failed', { error });
    });
    this._register(
      this.plugins.onDidReload((event) => {
        event.waitUntil(
          this.reloadPluginServers().catch((error: unknown) => {
            this.log.warn(`mcp plugin reload failed: ${String(error)}`);
          }),
        );
      }),
    );
    this._register(
      this.trust.onDidChange(() => {
        void this.reloadAfterTrustChange().catch((error: unknown) => {
          this.log.warn(`mcp trust reload failed: ${String(error)}`);
        });
      }),
    );
    this._register(
      mcpConfigStore.onDidWrite((event) => {
        event.waitUntil(
          this.reloadFileServers().catch((error: unknown) => {
            this.log.warn(`mcp config reload after management write failed: ${String(error)}`);
          }),
        );
      }),
    );
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain !== MCP_SECTION) return;
        const value = mcpTunablesFromSection(event.value as McpSection | undefined);
        const previous = mcpTunablesFromSection(event.previousValue as McpSection | undefined);
        if (
          value.reconnectInitialDelayMs === previous.reconnectInitialDelayMs &&
          value.reconnectMaxDelayMs === previous.reconnectMaxDelayMs
        ) {
          return;
        }
        this.tunablesEmitter.fire(value);
      }),
    );
    this._register({ dispose: () => this.projectWatcher?.dispose() });
    this.primaryReloadTail = this.watchConfigFiles();
    this._register(this.dirs.onDidChange(() => this.schedulePrimaryRefresh()));
  }

  private schedulePrimaryRefresh(): void {
    const refresh = (): Promise<void> => this.refreshPrimary();
    const reloaded = this.primaryReloadTail.then(refresh, refresh);
    this.primaryReloadTail = reloaded;
    void reloaded.catch((error: unknown) => {
      this.log.warn(`mcp primary reload failed: ${String(error)}`);
    });
  }

  servers(): Readonly<Record<string, McpServerConfig>> {
    return this.current;
  }

  sourceEntries(sourceId: McpProjectSourceId): Readonly<Record<string, McpServerConfigEntry>> {
    return this.layers[sourceId];
  }

  tunables(): McpTunables {
    return mcpTunablesFromSection(this.config.get<McpSection | undefined>(MCP_SECTION));
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async loadLayers(trusted: boolean): Promise<SourceEntriesMap> {
    const fileLayers = await loadMcpConfigLayers({
      fs: this.fs,
      cwd: this.dirs.primary,
      homeDir: this.bootstrap.homeDir,
      includeProject: trusted,
    });
    const next = emptySourceEntries();
    next.plugin = this.layers.plugin;
    for (const layer of fileLayers) {
      next[layer.sourceId] = layer.servers;
    }
    return next;
  }

  private async initialize(publish = false, preserveOAuthCredentials = false): Promise<void> {
    await this.config.ready;
    const trusted = await this.trust.get();
    const [layers, pluginServers, entries] = await Promise.all([
      this.loadLayers(trusted),
      this.plugins.enabledMcpServers(),
      this.plugins.mcpServerEntries(),
    ]);
    layers.plugin = pluginServers;
    this.disabledOAuthServers = retainedDisabledOAuthServers(
      entries,
      this.pluginServers,
      this.disabledOAuthServers,
    );
    this.pluginServers = new Map(Object.entries(pluginServers));
    this.initializationComplete = true;
    if (publish) {
      await this.publishIfChanged(layers, preserveOAuthCredentials);
    } else {
      this.layers = layers;
      this.current = this.merged();
      this.syncOAuthConfiguration();
    }
  }

  private async reloadAfterTrustChange(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      if (!this.initializationComplete) {
        await this.initialize(true, true);
        return;
      }
      const trusted = this.trust.isTrusted();
      if (!trusted && this.untrustedOAuthServers === undefined) {
        this.untrustedOAuthServers = this.mergedFiles();
      }
      const layers = await this.loadLayers(trusted);
      if (trusted) await this.reconcileUntrustedOAuthServers(this.mergedFiles(layers));
      await this.publishIfChanged(layers, true);
    });
  }

  private async reconcileUntrustedOAuthServers(
    fresh: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    const previousServers = this.untrustedOAuthServers;
    this.untrustedOAuthServers = undefined;
    if (previousServers === undefined) return;
    for (const [name, previous] of Object.entries(previousServers)) {
      if (!('url' in previous)) continue;
      const next = fresh[name];
      const identityChanged =
        next === undefined ||
        !('url' in next) ||
        mcpOAuthStoreKey(name, previous.url) !== mcpOAuthStoreKey(name, next.url);
      if (!identityChanged) continue;
      await this.cancelAuthorization(name, previous);
      await this.invalidateAuthorization(name, previous);
    }
  }

  private merged(): Record<string, McpServerConfig> {
    return mergeMcpServerEntries(MCP_PROJECT_SOURCE_IDS.map((id) => this.layers[id]));
  }

  private mergedFiles(layers: SourceEntriesMap = this.layers): Record<string, McpServerConfig> {
    return mergeMcpServerEntries([layers.user, layers['project-root'], layers.workspace]);
  }

  private async refreshPrimary(): Promise<void> {
    await this.dirs.ready;
    if (this.watchedPrimary === this.dirs.primary) return;
    await Promise.all([this.reloadFileServers(), this.refreshProjectConfigWatcher()]);
  }

  private async watchConfigFiles(): Promise<void> {
    const paths = await resolveMcpJsonPaths({
      fs: this.fs,
      cwd: this.dirs.primary,
      homeDir: this.bootstrap.homeDir,
    });
    this.watchPaths([paths.user]);
    await this.refreshProjectConfigWatcher();
  }

  private async refreshProjectConfigWatcher(): Promise<void> {
    const primary = this.dirs.primary;
    if (this.watchedPrimary === primary) return;
    const paths = await resolveMcpJsonPaths({
      fs: this.fs,
      cwd: primary,
      homeDir: this.bootstrap.homeDir,
    });
    const projectRoot = dirname(paths.projectRoot);
    const handle = watchCandidates(projectRoot, [paths.projectRoot, paths.project], {
      ignored: subtreeWatchFilter(projectRoot, [paths.projectRoot, paths.project]),
    });
    const subscription = handle.onDidChange(() => {
      this.scheduleFileReload();
    });
    this.projectWatcher?.dispose();
    this.projectWatcher = {
      dispose: () => {
        subscription.dispose();
        handle.dispose();
      },
    };
    this.watchedPrimary = primary;
  }

  private watchPaths(paths: readonly string[]): void {
    for (const path of paths) {
      const handle = watch(path);
      this._register(handle);
      this._register(
        handle.onDidChange(() => {
          this.scheduleFileReload();
        }),
      );
    }
  }

  private scheduleFileReload(): void {
    this.watchDebounce.cancelAndSet(() => {
      void this.reloadFileServers().catch((error: unknown) => {
        this.log.warn(`mcp config reload failed: ${String(error)}`);
      });
    }, WATCH_DEBOUNCE_MS);
  }

  private async reloadFileServers(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      const layers = await this.loadLayers(this.trust.isTrusted());
      await this.publishIfChanged(layers);
    });
  }

  private async reloadPluginServers(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      const [fresh, entries] = await Promise.all([
        this.plugins.enabledMcpServers(),
        this.plugins.mcpServerEntries(),
      ]);
      const previousDisabled = this.disabledOAuthServers;
      const retained = retainedDisabledOAuthServers(
        entries,
        this.pluginServers,
        previousDisabled,
      );
      this.disabledOAuthServers = retained;
      this.pluginServers = new Map(Object.entries(fresh));
      const layers: SourceEntriesMap = { ...this.layers, plugin: fresh };
      for (const [name, previous] of previousDisabled) {
        if (retained.has(name) || !('url' in previous)) continue;
        const next = entries.find((entry) => entry.name === name)?.config;
        if (
          next !== undefined &&
          'url' in next &&
          mcpOAuthStoreKey(name, previous.url) === mcpOAuthStoreKey(name, next.url)
        ) {
          continue;
        }
        const identityStillConfigured = [
          this.current[name],
          this.untrustedOAuthServers?.[name],
        ].some(
          (config) =>
            config !== undefined &&
            'url' in config &&
            mcpOAuthStoreKey(name, previous.url) === mcpOAuthStoreKey(name, config.url),
        );
        if (identityStillConfigured) continue;
        await this.cancelAuthorization(name, previous);
        await this.invalidateAuthorization(name, previous);
      }
      await this.publishIfChanged(layers, false, new Set(retained.keys()));
    });
  }

  private async publishIfChanged(
    nextLayers: SourceEntriesMap,
    preserveOAuthCredentials = false,
    preservedOAuthServers?: ReadonlySet<string>,
  ): Promise<void> {
    const previousLayers = this.layers;
    const next = mergeMcpServerEntries(MCP_PROJECT_SOURCE_IDS.map((id) => nextLayers[id]));
    const upsert: Record<string, McpServerConfig> = Object.create(null);
    const remove: string[] = [];
    for (const [name, config] of Object.entries(next)) {
      const previous = this.current[name];
      if (previous === undefined || fingerprintConfig(previous) !== fingerprintConfig(config)) {
        upsert[name] = config;
      }
    }
    for (const name of Object.keys(this.current)) {
      if (!Object.hasOwn(next, name)) remove.push(name);
    }
    for (const name of remove) {
      await this.cancelAuthorization(name, this.current[name]);
      if (!preserveOAuthCredentials && preservedOAuthServers?.has(name) !== true) {
        await this.invalidateAuthorization(name, this.current[name]);
      }
    }
    for (const [name, config] of Object.entries(upsert)) {
      const previous = this.current[name];
      const remoteIdentityChanged =
        previous !== undefined &&
        'url' in previous &&
        (!('url' in config) ||
          mcpOAuthStoreKey(name, previous.url) !== mcpOAuthStoreKey(name, config.url));
      if (config.enabled === false || remoteIdentityChanged) {
        await this.cancelAuthorization(name, previous);
      }
      if (remoteIdentityChanged && !preserveOAuthCredentials) {
        await this.invalidateAuthorization(name, previous);
      }
    }
    this.layers = nextLayers;
    this.current = next;
    this.syncOAuthConfiguration();
    if (Object.keys(upsert).length > 0 || remove.length > 0) {
      await this.changeEmitter.fireAsync({ upsert, remove }, NO_ABORT);
    }
    for (const sourceId of MCP_PROJECT_SOURCE_IDS) {
      const previousEntries = previousLayers[sourceId];
      const entries = nextLayers[sourceId];
      const changed =
        Object.keys(previousEntries).length !== Object.keys(entries).length ||
        Object.entries(entries).some(
          ([name, entry]) =>
            previousEntries[name] === undefined ||
            fingerprintConfig(previousEntries[name]) !== fingerprintConfig(entry),
        );
      if (!changed) continue;
      const sourceRemove = Object.keys(previousEntries).filter((name) => !Object.hasOwn(entries, name));
      await this.sourceChangeEmitter.fireAsync(
        { sourceId, upsert: entries, remove: sourceRemove },
        NO_ABORT,
      );
    }
  }

  private syncOAuthConfiguration(): void {
    if (this.disposed) return;
    const retained = this.untrustedOAuthServers ?? {};
    this.oauth.setConfigurationSource(
      this,
      [
        ...Object.entries(this.current),
        ...Object.entries(retained),
        ...this.disabledOAuthServers,
      ].flatMap(([name, config]) => ('url' in config ? [[name, config.url] as const] : [])),
    );
  }

  private async cancelAuthorization(
    name: string,
    config: McpServerConfig | undefined,
  ): Promise<void> {
    if (config === undefined || !('url' in config)) return;
    try {
      await this.oauth.cancelAuthorizationFromConfiguration(this, name, config.url);
    } catch (error) {
      this.log.warn('mcp oauth authorization cleanup failed', { name, error });
    }
  }

  private async invalidateAuthorization(
    name: string,
    config: McpServerConfig | undefined,
  ): Promise<void> {
    if (config === undefined || !('url' in config)) return;
    try {
      await this.oauth.invalidateFromConfiguration(this, name, config.url);
    } catch (error) {
      this.log.warn('mcp oauth credential cleanup failed', { name, error });
    }
  }
}

function retainedDisabledOAuthServers(
  entries: readonly PluginMcpServerEntry[],
  previousPlugins: ReadonlyMap<string, McpServerConfig>,
  previousDisabled: ReadonlyMap<string, McpServerConfig>,
): Map<string, McpServerConfig> {
  const retained = new Map<string, McpServerConfig>();
  for (const entry of entries) {
    if (entry.config.enabled !== false) continue;
    const previous = previousPlugins.get(entry.name) ?? previousDisabled.get(entry.name);
    const config = previous ?? entry.config;
    if ('url' in config) retained.set(entry.name, config);
  }
  return retained;
}

const NO_ABORT = new AbortController().signal;

function fingerprintConfig(config: McpServerConfigEntry): string {
  return JSON.stringify(sortKeysDeep(config));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortKeysDeep(nested)]),
    );
  }
  return value;
}
