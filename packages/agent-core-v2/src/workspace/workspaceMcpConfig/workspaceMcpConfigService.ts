import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { dirname } from 'pathe';

import type { McpServerConfig } from '#/mcpCore/config-schema';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import { loadMcpServers, resolveMcpJsonPaths } from './internal/config-loader';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
  type McpTunables,
} from './workspaceMcpConfig';

const WATCH_DEBOUNCE_MS = 200;

export class WorkspaceMcpConfigService extends Disposable implements IWorkspaceMcpConfigService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private fileServers = new Map<string, McpServerConfig>();
  private pluginServers = new Map<string, McpServerConfig>();
  private current: Readonly<Record<string, McpServerConfig>> = {};
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly changeEmitter = this._register(new Emitter<McpServersChange>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginService private readonly plugins: IPluginService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
  ) {
    super();
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp config initial load failed', { error });
    });
    this._register(
      this.plugins.onDidReload(() => {
        void this.reloadPluginServers().catch((error) => {
          this.log.warn(`mcp plugin reload failed: ${String(error)}`);
        });
      }),
    );
    this._register(
      this.trust.onDidChange(() => {
        void this.reloadFileServers().catch((error) => {
          this.log.warn(`mcp trust reload failed: ${String(error)}`);
        });
      }),
    );
    void this.watchConfigFiles();
  }

  servers(): Readonly<Record<string, McpServerConfig>> {
    return this.current;
  }

  tunables(): McpTunables {
    const section = this.config.get<McpSection | undefined>(MCP_SECTION);
    return {
      startupTimeoutMs: section?.startupTimeoutMs,
      toolTimeoutMs: section?.toolTimeoutMs,
    };
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.config.ready;
    await this.trust.ready;
    const [fileServers, pluginServers] = await Promise.all([
      loadMcpServers({
        fs: this.fs,
        cwd: this.workspace.cwd,
        homeDir: this.bootstrap.homeDir,
        includeProject: this.trust.isTrusted(),
      }),
      this.plugins.enabledMcpServers(),
    ]);
    this.fileServers = new Map(Object.entries(fileServers));
    this.pluginServers = new Map(Object.entries(pluginServers));
    this.current = this.merged();
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
      const fresh = await loadMcpServers({
        fs: this.fs,
        cwd: this.workspace.cwd,
        homeDir: this.bootstrap.homeDir,
        includeProject: this.trust.isTrusted(),
      });
      this.fileServers = new Map(Object.entries(fresh));
      this.publishIfChanged();
    });
  }

  private async reloadPluginServers(): Promise<void> {
    await this.ready;
    await this.mutate(async () => {
      const fresh = await this.plugins.enabledMcpServers();
      this.pluginServers = new Map(Object.entries(fresh));
      this.publishIfChanged();
    });
  }

  private publishIfChanged(): void {
    const next = this.merged();
    const upsert: Record<string, McpServerConfig> = {};
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
    this.current = next;
    if (Object.keys(upsert).length === 0 && remove.length === 0) return;
    this.changeEmitter.fire({ upsert, remove });
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

