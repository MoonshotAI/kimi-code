/**
 * `workspaceMcp` domain — `IWorkspaceMcpService` implementation.
 *
 * Owns the handler-wide `McpConnectionManager` (built at construction,
 * shared by every session of the workspace). This service drives the
 * initial connect from the config domain's snapshot, applies its reconciled
 * change events incrementally (serialized on a mutation tail, always after
 * the initial connect settles), feeds the manager's global timeout defaults
 * from the config domain's tunables at each (re)connect, and reports
 * connection telemetry for the initial load.
 * An outright initial-load or change-apply failure is logged (per-server
 * failures are status entries). The manager (and its stdio child processes,
 * whose cwd is the handler root) lives as long as the handler — i.e. the
 * process — so a stateful stdio server is shared by concurrent sessions of
 * the workspace rather than owned by one session. Bound at Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import { IWorkspaceMcpService } from './workspaceMcp';

export class WorkspaceMcpService extends Disposable implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IWorkspaceMcpConfigService private readonly mcpConfig: IWorkspaceMcpConfigService,
    @IMcpOAuthStore oauthStore: IMcpOAuthStore,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    const oauthService = new McpOAuthService({ store: oauthStore });
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: workspace.cwd,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
    });
    this._register({ dispose: () => void this.manager.shutdown() });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        this.scheduleApply(change);
      }),
    );
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
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
    await this.mcpConfig.ready;
    const servers = this.mcpConfig.servers();
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpServersChange): void {
    void this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error) => {
        this.log.warn(`mcp server change apply failed: ${String(error)}`);
      });
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.manager.remove(name);
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

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceMcpService,
  WorkspaceMcpService,
  ScopeActivation.OnScopeCreated,
  'workspaceMcp',
);
