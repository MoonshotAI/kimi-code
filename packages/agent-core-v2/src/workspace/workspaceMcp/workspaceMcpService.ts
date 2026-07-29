/**
 * `workspaceMcp` domain (L5) — `IWorkspaceMcpService` implementation.
 *
 * Owns the handler-wide `McpConnectionManager` (built at construction,
 * shared by every session of the workspace) fed by exactly two sources —
 * the MCP config files and the enabled plugins; on a name collision the
 * file config wins, and when one source's server vanishes the same-named
 * entry from the other source takes over. Resolves the file + plugin MCP
 * config, drives the initial connect, and watches the MCP config files
 * (`resolveMcpJsonPaths`: user `mcp.json`, project-root `.mcp.json`,
 * `.kimi-code/mcp.json`) to reconcile file-sourced entries debounced.
 * Plugin-sourced entries follow `plugins.onDidReload` the same way:
 * `enabledMcpServers()` is re-resolved and reconciled, so a plugin
 * installed, enabled or reloaded AFTER the handler materialized still
 * contributes its MCP servers. There is deliberately no caller-supplied
 * server channel: sessions cannot contribute MCP servers on create/resume.
 * The initial connect waits for `config.ready` so global timeout
 * preferences are deterministic; the manager reads them again at each
 * (re)connect. Connection telemetry is reported for the initial load; an
 * outright initial-load or watch-reload failure is logged (per-server
 * failures are status entries). The manager (and its stdio child processes,
 * whose cwd is the handler root) lives as long as the handler — i.e. the
 * process — so a stateful stdio server is now shared by concurrent sessions
 * of the workspace rather than owned by one session. Bound at Workspace
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { dirname } from 'pathe';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { resolveMcpJsonPaths } from '#/agent/mcp/config-loader';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { MCP_SECTION, type McpSection } from '#/agent/mcp/configSection';
import { McpOAuthService } from '#/agent/mcp/oauth/service';
import { createMcpOAuthStore } from '#/agent/mcp/oauth/store';
import { resolveSessionMcpConfig } from '#/agent/mcp/session-config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceMcpService } from './workspaceMcp';

const WATCH_DEBOUNCE_MS = 200;

export class WorkspaceMcpService extends Disposable implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  readonly ready: Promise<void>;
  /** Serializes watch/plugin reloads against each other. */
  private mutationTail: Promise<void> = Promise.resolve();
  /** File-sourced server configs by name (the winning source on collisions). */
  private fileServers = new Map<string, McpServerConfig>();
  /** Plugin-sourced server configs by name. */
  private pluginServers = new Map<string, McpServerConfig>();
  private readonly watchDebounce = this._register(new TimeoutTimer());

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginService private readonly plugins: IPluginService,
    @IAtomicDocumentStore atomicDocs: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
  ) {
    super();
    const oauthService = new McpOAuthService({
      store: createMcpOAuthStore(atomicDocs),
    });
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: this.workspace.cwd,
      resolveDefaultTimeouts: () => {
        const section = this.config.get<McpSection | undefined>(MCP_SECTION);
        return {
          startupTimeoutMs: section?.startupTimeoutMs,
          toolTimeoutMs: section?.toolTimeoutMs,
        };
      },
    });
    this._register({ dispose: () => void this.manager.shutdown() });
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
    this._register(
      this.plugins.onDidReload(() => {
        void this.reloadPluginServers().catch((error) => {
          this.log.warn(`mcp plugin reload failed: ${String(error)}`);
        });
      }),
    );
    void this.watchConfigFiles();
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  sessionHandle(): ISessionMcpHandle {
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: this.manager,
    };
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.config.ready;
    const [base, pluginServers] = await Promise.all([
      resolveSessionMcpConfig({ cwd: this.workspace.cwd, homeDir: this.bootstrap.homeDir }),
      this.plugins.enabledMcpServers(),
    ]);
    for (const [name, config] of Object.entries(base?.servers ?? {})) {
      this.fileServers.set(name, config);
    }
    for (const [name, config] of Object.entries(pluginServers)) {
      this.pluginServers.set(name, config);
    }
    // File config wins on a name collision.
    const servers = { ...pluginServers, ...base?.servers };
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private async watchConfigFiles(): Promise<void> {
    const paths = await resolveMcpJsonPaths({
      cwd: this.workspace.cwd,
      homeDir: this.bootstrap.homeDir,
    });
    // The user file's parent (the kimi home) always exists, so a direct
    // watch is reliable; the project candidates' parents may not exist yet,
    // so the project root is watched recursively and pruned to them.
    this.watchPaths([paths.user]);
    const projectRoot = dirname(paths.projectRoot);
    const handle = this.fsWatch.watch(projectRoot, {
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
      const handle = this.fsWatch.watch(path);
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
      const fresh = (await resolveSessionMcpConfig({
        cwd: this.workspace.cwd,
        homeDir: this.bootstrap.homeDir,
      }))?.servers ?? {};
      for (const name of this.fileServers.keys()) {
        if (Object.hasOwn(fresh, name)) continue;
        // The file server vanished: fall back to the same-named plugin
        // server when one exists, otherwise disconnect.
        const pluginConfig = this.pluginServers.get(name);
        if (pluginConfig !== undefined) {
          await this.connectUnlessCurrent(name, pluginConfig);
          continue;
        }
        await this.manager.remove(name);
      }
      for (const [name, config] of Object.entries(fresh)) {
        const previous = this.fileServers.get(name);
        if (previous !== undefined && fingerprintConfig(previous) === fingerprintConfig(config)) {
          continue;
        }
        // New or changed file server (file config wins on a name
        // collision, so a same-named plugin entry is replaced too).
        await this.manager.connect(name, config);
      }
      this.fileServers = new Map(Object.entries(fresh));
    });
  }

  private async reloadPluginServers(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      const fresh = await this.plugins.enabledMcpServers();
      for (const name of this.pluginServers.keys()) {
        if (Object.hasOwn(fresh, name)) continue;
        // The plugin server vanished: fall back to the same-named file
        // server when one exists, otherwise disconnect.
        const fileConfig = this.fileServers.get(name);
        if (fileConfig !== undefined) {
          await this.connectUnlessCurrent(name, fileConfig);
          continue;
        }
        await this.manager.remove(name);
      }
      for (const [name, config] of Object.entries(fresh)) {
        // File config wins on a name collision — leave the file entry.
        if (this.fileServers.has(name)) continue;
        const previous = this.pluginServers.get(name);
        if (previous !== undefined && fingerprintConfig(previous) === fingerprintConfig(config)) {
          continue;
        }
        await this.manager.connect(name, config);
      }
      this.pluginServers = new Map(Object.entries(fresh));
    });
  }

  /** (Re)connect only when the live entry is not already on this config. */
  private async connectUnlessCurrent(name: string, config: McpServerConfig): Promise<void> {
    const current = this.manager.configOf(name);
    if (current !== undefined && fingerprintConfig(current) === fingerprintConfig(config)) return;
    await this.manager.connect(name, config);
  }

  private trackMcpInitialLoad(): void {
    const entries = this.manager.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track2('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track2('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }
}

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

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceMcpService,
  WorkspaceMcpService,
  ScopeActivation.OnScopeCreated,
  'workspaceMcp',
);
