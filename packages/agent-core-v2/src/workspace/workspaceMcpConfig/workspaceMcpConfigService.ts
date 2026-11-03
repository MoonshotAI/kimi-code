import { dirname } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { loadMcpServers, resolveMcpJsonPaths } from '#/app/mcpConfig/configLoader';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginMcpServerEntry } from '#/app/plugin/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { mcpOAuthStoreKey } from '#/mcpCore/oauth/store';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { watch, watchCandidates } from '#human/utils/watch';

import {
  IWorkspaceMcpConfigService,
  type McpServersChangeEvent,
  type McpTunables,
} from './workspaceMcpConfig';

const WATCH_DEBOUNCE_MS = 200;

export class WorkspaceMcpConfigService extends Disposable implements IWorkspaceMcpConfigService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private fileServers = new Map<string, McpServerConfig>();
  private pluginServers = new Map<string, McpServerConfig>();
  private disabledOAuthServers = new Map<string, McpServerConfig>();
  private current: Readonly<Record<string, McpServerConfig>> = {};
  private untrustedOAuthServers: Readonly<Record<string, McpServerConfig>> | undefined;
  private initializationComplete = false;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly changeEmitter = this._register(new AsyncEmitter<McpServersChangeEvent>());
  private readonly tunablesEmitter = this._register(new Emitter<McpTunables>());
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeTunables = this.tunablesEmitter.event;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginService private readonly plugins: IPluginService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
    @IMcpConfigStore mcpConfigStore: IMcpConfigStore,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
  ) {
    super();
    this.oauth.setConfigurationSource(this, []);
    this._register({ dispose: () => this.oauth.removeConfigurationSource(this) });
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp config initial load failed', { error });
    });
    this._register(
      this.plugins.onDidReload((event) => {
        event.waitUntil(
          this.reloadPluginServers().catch((error) => {
            this.log.warn(`mcp plugin reload failed: ${String(error)}`);
          }),
        );
      }),
    );
    this._register(
      this.trust.onDidChange(() => {
        void this.reloadAfterTrustChange().catch((error) => {
          this.log.warn(`mcp trust reload failed: ${String(error)}`);
        });
      }),
    );
    this._register(
      mcpConfigStore.onDidWrite((event) => {
        event.waitUntil(
          this.reloadFileServers().catch((error) => {
            this.log.warn(`mcp config reload after management write failed: ${String(error)}`);
          }),
        );
      }),
    );
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain !== MCP_SECTION) return;
        const value = toMcpTunables(event.value as McpSection | undefined);
        const previous = toMcpTunables(event.previousValue as McpSection | undefined);
        if (
          value.reconnectInitialDelayMs === previous.reconnectInitialDelayMs &&
          value.reconnectMaxDelayMs === previous.reconnectMaxDelayMs
        ) {
          return;
        }
        this.tunablesEmitter.fire(value);
      }),
    );
    void this.watchConfigFiles();
  }

  servers(): Readonly<Record<string, McpServerConfig>> {
    return this.current;
  }

  tunables(): McpTunables {
    return toMcpTunables(this.config.get<McpSection | undefined>(MCP_SECTION));
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(publish = false, preserveOAuthCredentials = false): Promise<void> {
    await this.config.ready;
    const trusted = await this.trust.get();
    const [fileServers, pluginServers, entries] = await Promise.all([
      loadMcpServers({
        fs: this.fs,
        cwd: this.workspace.cwd,
        homeDir: this.bootstrap.homeDir,
        includeProject: trusted,
      }),
      this.plugins.enabledMcpServers(),
      this.plugins.mcpServerEntries(),
    ]);
    this.fileServers = new Map(Object.entries(fileServers));
    this.disabledOAuthServers = retainedDisabledOAuthServers(
      entries,
      this.pluginServers,
      this.disabledOAuthServers,
    );
    this.pluginServers = new Map(Object.entries(pluginServers));
    this.initializationComplete = true;
    if (publish) {
      await this.publishIfChanged(preserveOAuthCredentials);
    } else {
      this.current = this.merged();
      this.syncOAuthConfiguration();
    }
  }

  private async reloadAfterTrustChange(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      if (!this.initializationComplete) {
        await this.initialize(true, true);
      } else {
        const trusted = this.trust.isTrusted();
        if (!trusted && this.untrustedOAuthServers === undefined) {
          this.untrustedOAuthServers = Object.fromEntries(this.fileServers);
        }
        const fresh = await loadMcpServers({
          fs: this.fs,
          cwd: this.workspace.cwd,
          homeDir: this.bootstrap.homeDir,
          includeProject: trusted,
        });
        if (trusted) await this.reconcileUntrustedOAuthServers(fresh);
        this.fileServers = new Map(Object.entries(fresh));
      }
      await this.publishIfChanged(true);
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
    return { ...Object.fromEntries(this.pluginServers), ...Object.fromEntries(this.fileServers) };
  }

  private async watchConfigFiles(): Promise<void> {
    const paths = await resolveMcpJsonPaths({
      fs: this.fs,
      cwd: this.workspace.cwd,
      homeDir: this.bootstrap.homeDir,
    });
    this.watchPaths([paths.user]);
    const projectRoot = dirname(paths.projectRoot);
    const handle = watchCandidates(projectRoot, [paths.projectRoot, paths.project], {
      ignored: subtreeWatchFilter(projectRoot, [paths.projectRoot, paths.project]),
    });
    this._register(handle);
    this._register(
      handle.onDidChange(() => {
        this.scheduleFileReload();
      }),
    );
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
      void this.reloadFileServers().catch((error) => {
        this.log.warn(`mcp config reload failed: ${String(error)}`);
      });
    }, WATCH_DEBOUNCE_MS);
  }

  private async reloadFileServers(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      const fresh = await loadMcpServers({
        fs: this.fs,
        cwd: this.workspace.cwd,
        homeDir: this.bootstrap.homeDir,
        includeProject: this.trust.isTrusted(),
      });
      this.fileServers = new Map(Object.entries(fresh));
      await this.publishIfChanged();
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
      await this.publishIfChanged(false, new Set(retained.keys()));
    });
  }

  private async publishIfChanged(
    preserveOAuthCredentials = false,
    preservedOAuthServers?: ReadonlySet<string>,
  ): Promise<void> {
    const next = this.merged();
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
    this.current = next;
    this.syncOAuthConfiguration();
    if (Object.keys(upsert).length === 0 && remove.length === 0) return;
    await this.changeEmitter.fireAsync({ upsert, remove }, NO_ABORT);
  }

  private syncOAuthConfiguration(): void {
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

function toMcpTunables(section: McpSection | undefined): McpTunables {
  return {
    startupTimeoutMs: section?.startupTimeoutMs,
    toolTimeoutMs: section?.toolTimeoutMs,
    defaultDeferred: section?.defaultDeferred,
    reconnectInitialDelayMs: section?.reconnectInitialDelayMs,
    reconnectMaxDelayMs: section?.reconnectMaxDelayMs,
  };
}

const NO_ABORT = new AbortController().signal;

function fingerprintConfig(config: McpServerConfig): string {
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
