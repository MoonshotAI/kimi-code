import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { mergeMcpServerEntries } from '#/app/mcpConfig/configLoader';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { subscribeMcpOAuthEvents } from '#/mcpCore/oauth/connectionBinding';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { RefCountedMcpServerPool } from '#/mcpCore/refCountedPool';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import {
  IProjectMcpConfigService,
  MCP_PROJECT_SOURCE_IDS,
  type McpDirs,
  type McpProjectSourceId,
} from '#/project/projectMcpConfig/projectMcpConfig';
import { arbitrateMcpSources, MCP_SOURCE_PRIORITY, type McpSource } from '#/session/mcp/mcpSource';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';

import { IProjectMcpService } from './projectMcp';

interface ProjectMcpSourceRuntime {
  readonly source: McpSource & {
    readonly id: McpProjectSourceId;
    readonly view: McpConnectionManager;
  };
  readonly pool: RefCountedMcpServerPool;
  readonly emitter: Emitter<void>;
}

export class ProjectMcpService extends Disposable implements IProjectMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly projectSources: ProjectMcpSourceRuntime[] = [];
  private readonly combined = new MergedMcpConnectionView();
  private appliedPrimary?: string;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly resolveClientName = (): string | undefined => this.identity.current().slug;
  private initialLoadTracked = false;
  private readonly completedInitialSourcesByOwner = new Map<string, Set<string>>();
  private projectOwnerSeq = 0;
  private shutdown?: Promise<void>;

  constructor(
    @IProjectDirs private readonly dirs: McpDirs,
    @IEnvironmentService private readonly environmentResolver: EnvironmentResolver,
    @IProjectMcpConfigService private readonly mcpConfig: IProjectMcpConfigService,
    @IMcpOAuthService oauthService: McpOAuthService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {
    super();
    this._register(this.combined);
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
    for (const id of MCP_PROJECT_SOURCE_IDS) {
      const manager = new McpConnectionManager({
        log: this.log,
        oauthService,
        stdioCwd: () => this.dirs.primary,
        environmentResolver: this.environmentResolver,
        environmentId: 'local',
        reconnectRetryEnabled: true,
        resolveDefaults: () => this.mcpConfig.tunables(),
        resolveClientName: this.resolveClientName,
      });
      const pool = new RefCountedMcpServerPool(manager);
      const emitter = this._register(new Emitter<void>());
      const source: ProjectMcpSourceRuntime['source'] = {
        id,
        priority: MCP_SOURCE_PRIORITY[id],
        ready: this.ready,
        view: manager,
        entries: () => this.mcpConfig.sourceEntries(id),
        onDidChangeEntries: emitter.event,
        stdioCwd: () => this.dirs.primary,
        acquire: async (ownerId, servers) => {
          await this.ready;
          await pool.acquire(ownerId, servers);
          const completed = this.completedInitialSourcesByOwner.get(ownerId) ?? new Set<string>();
          completed.add(id);
          this.completedInitialSourcesByOwner.set(ownerId, completed);
          if (completed.size !== MCP_PROJECT_SOURCE_IDS.length) return;
          this.completedInitialSourcesByOwner.delete(ownerId);
          this.trackMcpInitialLoadOnce();
        },
        release: (ownerId) => pool.release(ownerId),
      };
      this.projectSources.push({ source, pool, emitter });
      this.combined.addLayer(source);
      this._register({ dispose: subscribeMcpOAuthEvents(oauthService, this.log, manager) });
    }
    this._register(
      this.mcpConfig.onDidChange((change) => {
        change.waitUntil(this.ready.then(() => this.publishEntries()));
      }),
    );
    this._register(
      this.mcpConfig.onDidChangeSource((change) => {
        change.waitUntil(this.ready.then(() => this.publishEntries()));
      }),
    );
    this._register(
      this.mcpConfig.onDidChangeTunables(() => {
        this.combined.rescheduleRetries();
      }),
    );
    this._register(
      this.dirs.onDidChange(() => {
        this.schedulePrimaryRebind();
      }),
    );
  }

  override dispose(): void {
    void this.disposeAsync().catch((error: unknown) => {
      this.log.error('mcp disposal failed', { error });
    });
  }

  disposeAsync(): Promise<void> {
    this.shutdown ??= (async () => {
      let disposalError: unknown;
      try {
        super.dispose();
      } catch (error) {
        disposalError = error;
      }
      const results = await Promise.allSettled(
        this.projectSources.map(({ source }) => source.view.dispose()),
      );
      const managerError: unknown = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )?.reason;
      if (disposalError !== undefined) {
        throw disposalError instanceof Error
          ? disposalError
          : new Error('MCP disposal failed', { cause: disposalError });
      }
      if (managerError !== undefined) {
        throw managerError instanceof Error
          ? managerError
          : new Error('MCP disposal failed', { cause: managerError });
      }
    })();
    return this.shutdown;
  }

  connectionManager(): MergedMcpConnectionView {
    return this.combined;
  }

  async acquire(): Promise<() => Promise<void>> {
    await this.ready;
    if (this.shutdown !== undefined) return async () => undefined;
    const ownerId = `project-${++this.projectOwnerSeq}`;
    const winners = arbitrateMcpSources(this.sources());
    await Promise.allSettled(
      this.projectSources.map(({ source, pool }) =>
        pool.acquire(ownerId, winners.get(source.id) ?? {}),
      ),
    );
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await Promise.allSettled(
        this.projectSources.map(({ pool }) => pool.release(ownerId)),
      );
    };
  }

  sources(): readonly McpSource[] {
    return this.projectSources.map(({ source }) => source);
  }

  private publishEntries(): void {
    const sources = this.sources();
    const activatingNames = new Set<string>();
    for (const configs of arbitrateMcpSources(sources).values()) {
      for (const name of Object.keys(configs)) activatingNames.add(name);
    }
    this.combined.setEffectiveEntries(
      mergeMcpServerEntries(sources.map((source) => source.entries())),
      activatingNames,
    );
    for (const { emitter } of this.projectSources) emitter.fire();
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private schedulePrimaryRebind(): void {
    void this.ready
      .then(() =>
        this.mutate(async () => {
          const primary = this.dirs.primary;
          if (primary === this.appliedPrimary) return;
          for (const { source } of this.projectSources) {
            const configs = this.mcpConfig.sourceEntries(source.id);
            for (const entry of source.view.list()) {
              const config = configs[entry.name];
              if (config === undefined || !('transport' in config)) continue;
              if (config.transport !== 'stdio' || config.cwd !== undefined || config.enabled === false) {
                continue;
              }
              try {
                await this.combined.reconnect(entry.name);
              } catch (error) {
                this.log.warn(`mcp primary reconnect failed for ${entry.name}: ${String(error)}`);
              }
            }
          }
          this.appliedPrimary = primary;
        }),
      )
      .catch((error: unknown) => {
        this.log.warn(`mcp primary reconnect failed: ${String(error)}`);
      });
  }

  private async initialize(): Promise<void> {
    await this.mcpConfig.ready;
    await this.identity.resolved();
    this.appliedPrimary = this.dirs.primary;
    this.publishEntries();
  }

  private trackMcpInitialLoadOnce(): void {
    if (this.initialLoadTracked) return;
    this.initialLoadTracked = true;
    const entries = this.projectSources
      .flatMap(({ source }) => source.view.list())
      .filter((entry) => entry.status !== 'disabled');
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
