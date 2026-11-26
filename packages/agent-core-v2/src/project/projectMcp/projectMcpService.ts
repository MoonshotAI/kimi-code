import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { subscribeMcpOAuthEvents } from '#/mcpCore/oauth/connectionBinding';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import {
  IProjectMcpConfigService,
  type McpDirs,
  type McpServersChange,
} from '#/project/projectMcpConfig/projectMcpConfig';
import { MCP_SOURCE_PRIORITY, type McpSource } from '#/session/mcp/mcpSource';

import { IProjectMcpService } from './projectMcp';

export class ProjectMcpService extends Disposable implements IProjectMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
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
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: () => this.dirs.primary,
      environmentResolver: this.environmentResolver,
      environmentId: 'local',
      reconnectRetryEnabled: true,
      resolveDefaults: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        change.waitUntil(this.scheduleApply(change));
      }),
    );
    this._register(
      this.mcpConfig.onDidChangeTunables(() => {
        this.manager.rescheduleRetries();
      }),
    );
    this._register(
      this.dirs.onDidChange(() => {
        this.schedulePrimaryRebind();
      }),
    );
    this._register({ dispose: subscribeMcpOAuthEvents(oauthService, this.log, this.manager) });
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
      await this.manager.dispose();
      if (disposalError !== undefined) {
        throw disposalError instanceof Error
          ? disposalError
          : new Error('MCP disposal failed', { cause: disposalError });
      }
    })();
    return this.shutdown;
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  source(): McpSource {
    return {
      id: 'project',
      priority: MCP_SOURCE_PRIORITY.project,
      ready: this.ready,
      view: this.manager,
      stdioCwd: () => this.dirs.primary,
    };
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
          for (const [name, config] of Object.entries(this.mcpConfig.servers())) {
            if (config.transport !== 'stdio' || config.cwd !== undefined || config.enabled === false) {
              continue;
            }
            if (this.manager.get(name) === undefined) continue;
            try {
              await this.manager.reconnect(name);
            } catch (error) {
              this.log.warn(`mcp primary reconnect failed for ${name}: ${String(error)}`);
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
    const servers = this.mcpConfig.servers();
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpServersChange): Promise<void> {
    return this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error: unknown) => {
        this.log.warn(`mcp server change apply failed: ${String(error)}`);
      });
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.manager.markRemoved(name);
    }
    for (const [name, config] of Object.entries(change.upsert)) {
      await this.manager.connect(name, config);
    }
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
