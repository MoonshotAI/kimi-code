/**
 * `mcp` domain (L5) — `ISessionMcpService` implementation.
 *
 * Owns the shared session connection manager and initial connection lifecycle.
 * Resolves server sources through `bootstrap`, `workspace`, and `plugin`,
 * timeout preferences through `config`, OAuth storage through `persistence`,
 * and reports through `log` and `telemetry`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import { MCP_SECTION, type McpSection } from '#/agent/mcp/configSection';
import { McpOAuthService } from '#/agent/mcp/oauth/service';
import { createMcpOAuthStore } from '#/agent/mcp/oauth/store';
import { mergeCallerMcpServers, resolveSessionMcpConfig } from '#/agent/mcp/session-config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { ISessionMcpService } from './sessionMcp';

export class SessionMcpService extends Disposable implements ISessionMcpService {
  declare readonly _serviceBrand: undefined;

  private mcpManager: McpConnectionManager | undefined;
  private mcpInitialLoad: Promise<void> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IPluginService private readonly plugins: IPluginService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
  }

  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void> {
    if (this.mcpInitialLoad !== undefined) return this.mcpInitialLoad;
    const initialLoad = this.initializeMcp(callerServers).catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
    this.mcpInitialLoad = initialLoad;
    return initialLoad;
  }

  connectionManager(): McpConnectionManager {
    if (this.mcpManager === undefined) {
      throw new Error2(
        ErrorCodes.MCP_STARTUP_FAILED,
        'MCP connection manager is not ready; await ensureMcpReady() first',
      );
    }
    return this.mcpManager;
  }

  private async initializeMcp(
    callerServers?: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    await this.config.ready;
    const oauthService = new McpOAuthService({
      store: createMcpOAuthStore(this.atomicDocs),
    });
    const mcpSection = this.config.get<McpSection | undefined>(MCP_SECTION);
    const manager = new McpConnectionManager({
      log: this.log,
      oauthService,
      stdioCwd: this.workspace.workDir,
      defaultStartupTimeoutMs: mcpSection?.startupTimeoutMs,
      defaultToolTimeoutMs: mcpSection?.toolTimeoutMs,
    });
    this.mcpManager = manager;
    this._register({ dispose: () => void manager.shutdown() });
    await this.connectMcpServers(manager, callerServers);
  }

  private async connectMcpServers(
    manager: McpConnectionManager,
    callerServers?: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    const [base, pluginServers] = await Promise.all([
      resolveSessionMcpConfig({ cwd: this.workspace.workDir, homeDir: this.bootstrap.homeDir }),
      this.plugins.enabledMcpServers(),
    ]);
    const withCaller = mergeCallerMcpServers(base, callerServers);
    const servers = { ...withCaller?.servers, ...pluginServers };
    if (Object.keys(servers).length === 0) return;
    await manager.connectAll(servers);
    this.trackMcpInitialLoad(manager);
  }

  private trackMcpInitialLoad(manager: McpConnectionManager): void {
    const entries = manager.list().filter((entry) => entry.status !== 'disabled');
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
  LifecycleScope.Session,
  ISessionMcpService,
  SessionMcpService,
  InstantiationType.Eager,
  'sessionMcp',
);
