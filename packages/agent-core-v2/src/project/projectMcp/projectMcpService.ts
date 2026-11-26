import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { mergeMcpServerEntries } from '#/app/mcpConfig/configLoader';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { subscribeMcpOAuthEvents } from '#/mcpCore/oauth/connectionBinding';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import {
  fullMcpServerConfigs,
} from '#/project/projectMcpConfig/projectMcpConfigService';
import {
  IProjectMcpConfigService,
  MCP_PROJECT_SOURCE_IDS,
  type McpDirs,
  type McpProjectSourceId,
  type McpSourceServersChange,
} from '#/project/projectMcpConfig/projectMcpConfig';
import { MCP_SOURCE_PRIORITY, type McpSource } from '#/session/mcp/mcpSource';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';

import { IProjectMcpService } from './projectMcp';

export class ProjectMcpService extends Disposable implements IProjectMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly managers = new Map<McpProjectSourceId, McpConnectionManager>();
  private readonly entryEmitters = new Map<McpProjectSourceId, Emitter<void>>();
  private readonly combined = new MergedMcpConnectionView();
  private appliedPrimary?: string;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly resolveClientName = (): string | undefined => this.identity.current().slug;
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
    for (const sourceId of MCP_PROJECT_SOURCE_IDS) {
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
      this.managers.set(sourceId, manager);
      this.entryEmitters.set(sourceId, this._register(new Emitter<void>()));
      this.combined.addLayer({
        id: sourceId,
        priority: MCP_SOURCE_PRIORITY[sourceId],
        view: manager,
      });
      this._register({ dispose: subscribeMcpOAuthEvents(oauthService, this.log, manager) });
    }
    this._register(
      this.mcpConfig.onDidChange((change) => {
        change.waitUntil(
          this.ready.then(() => {
            this.combined.setEffectiveEntries(
              mergeMcpServerEntries(
                MCP_PROJECT_SOURCE_IDS.map((id) => this.mcpConfig.sourceEntries(id)),
              ),
            );
          }),
        );
      }),
    );
    this._register(
      this.mcpConfig.onDidChangeSource((change) => {
        change.waitUntil(this.scheduleApply(change));
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
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
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
        [...this.managers.values()].map((manager) => manager.dispose()),
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

  sourceManager(sourceId: string): McpConnectionManager | undefined {
    return this.managers.get(sourceId as McpProjectSourceId);
  }

  sources(): readonly McpSource[] {
    return MCP_PROJECT_SOURCE_IDS.map((id) => ({
      id,
      priority: MCP_SOURCE_PRIORITY[id],
      ready: this.ready,
      view: this.managers.get(id)!,
      entries: () => this.mcpConfig.sourceEntries(id),
      onDidChangeEntries: this.entryEmitter(id).event,
      stdioCwd: () => this.dirs.primary,
    }));
  }

  private entryEmitter(id: McpProjectSourceId): Emitter<void> {
    return this.entryEmitters.get(id)!;
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
          for (const sourceId of MCP_PROJECT_SOURCE_IDS) {
            const manager = this.managers.get(sourceId)!;
            const configs = fullMcpServerConfigs(this.mcpConfig.sourceEntries(sourceId));
            for (const [name, config] of Object.entries(configs)) {
              if (config.transport !== 'stdio' || config.cwd !== undefined || config.enabled === false) {
                continue;
              }
              if (manager.get(name) === undefined) continue;
              try {
                await this.combined.reconnect(name);
              } catch (error) {
                this.log.warn(`mcp primary reconnect failed for ${name}: ${String(error)}`);
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
    const layers = MCP_PROJECT_SOURCE_IDS.map((id) => this.mcpConfig.sourceEntries(id));
    await Promise.all(
      MCP_PROJECT_SOURCE_IDS.map((id) => {
        const servers = fullMcpServerConfigs(this.mcpConfig.sourceEntries(id));
        if (Object.keys(servers).length === 0) return Promise.resolve();
        return this.managers.get(id)!.connectAll(servers);
      }),
    );
    this.combined.setEffectiveEntries(mergeMcpServerEntries(layers));
    for (const id of MCP_PROJECT_SOURCE_IDS) {
      this.entryEmitter(id).fire();
    }
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpSourceServersChange): Promise<void> {
    return this.ready
      .then(() =>
        this.mutate(async () => {
          await this.apply(change);
          this.entryEmitter(change.sourceId).fire();
          this.combined.setEffectiveEntries(
            mergeMcpServerEntries(
              MCP_PROJECT_SOURCE_IDS.map((id) => this.mcpConfig.sourceEntries(id)),
            ),
          );
        }),
      )
      .catch((error: unknown) => {
        this.log.warn(`mcp server change apply failed: ${String(error)}`);
      });
  }

  private async apply(change: McpSourceServersChange): Promise<void> {
    const manager = this.managers.get(change.sourceId)!;
    const upserts: Readonly<Record<string, McpServerConfig>> = fullMcpServerConfigs(change.upsert);
    for (const name of new Set([...change.remove, ...manager.list().map((entry) => entry.name)])) {
      if (Object.hasOwn(upserts, name)) continue;
      await manager.markRemoved(name);
    }
    for (const [name, config] of Object.entries(upserts)) {
      await manager.connect(name, config);
    }
  }

  private trackMcpInitialLoad(): void {
    const entries = [...this.managers.values()]
      .flatMap((manager) => manager.list())
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
