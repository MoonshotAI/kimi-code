import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpConnectionView,
  type McpServerEntry,
} from '#/mcpCore/connection-manager';
import type { McpOAuthEvent, McpOAuthService } from '#/mcpCore/oauth/service';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
  type SessionMcpOverlayOptions,
} from './workspaceMcp';

export class WorkspaceMcpService extends Disposable implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  private readonly oauthService: McpOAuthService;
  private readonly stdioCwd: string;
  private readonly workspaceId: string;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly resolveClientName = (): string | undefined => this.identity.current().slug;
  private readonly sessionLifecycle: LiveRef<ISessionManager>;
  private sessionLifecycleAttached = false;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @IWorkspaceMcpConfigService private readonly mcpConfig: IWorkspaceMcpConfigService,
    @IMcpOAuthService oauthService: McpOAuthService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ref(ISessionManager) sessionLifecycle: LiveRef<ISessionManager>,
  ) {
    super();
    this.sessionLifecycle = sessionLifecycle;
    this.stdioCwd = workspace.cwd;
    this.workspaceId = workspace.workspaceId;
    this.oauthService = oauthService;
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: workspace.workspaceId,
      runtimeId: 'local',
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    this._register({ dispose: () => void this.manager.shutdown() });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        change.waitUntil(this.scheduleApply(change));
      }),
    );
    this._register({ dispose: this.oauthEventSubscription(this.manager) });
    this.attachSessionLifecycle();
    this._register(sessionLifecycle.onDidChange(() => this.attachSessionLifecycle()));
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
  }

  private attachSessionLifecycle(): void {
    if (this.sessionLifecycleAttached) return;
    const lifecycle = this.sessionLifecycle.current;
    if (lifecycle?.onWillCreateSession === undefined) return;
    this.sessionLifecycleAttached = true;
    this._register(
      lifecycle.onWillCreateSession((event) => {
        if (event.readSeed(ISessionContext).workspaceId !== this.workspaceId) return;
        const servers = event.readSeed(ISessionEphemeralMcpServers);
        if (Object.keys(servers).length === 0) return;
        const overlay = this.sessionOverlay(servers, {
          stdioCwd: event.readSeed(ISessionContext).cwd,
        });
        event.contributeSeed(ISessionMcpHandle, overlay.handle);
        event.onSessionDispose(() => {
          void overlay.shutdown();
        });
      }),
    );
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  sessionHandle(): ISessionMcpHandle {
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: this.manager,
      isBaselineServer: this.sessionBaseline(this.manager, this.ready),
    };
  }

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
  ): ISessionMcpOverlay {
    const sessionManager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: opts?.stdioCwd ?? this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: this.workspaceId,
      runtimeId: 'local',
      requireStdioRuntimeId: true,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    const connect = Promise.all([this.mcpConfig.ready, this.identity.resolved()])
      .then(() => sessionManager.connectAll({ ...servers }))
      .catch((error: unknown) => {
        this.log.error('session mcp overlay initial load failed', { error });
      });
    const unsubscribeOAuth = this.oauthEventSubscription(sessionManager);
    const view = new MergedMcpConnectionView(
      this.manager,
      sessionManager,
      new Set(Object.keys(servers)),
    );
    const ready = Promise.all([this.ready, connect]).then(() => undefined);
    return {
      handle: {
        _serviceBrand: undefined,
        ready,
        connectionManager: view,
        isBaselineServer: this.sessionBaseline(this.manager, this.ready, Object.keys(servers)),
      },
      shutdown: () => {
        unsubscribeOAuth();
        return sessionManager.shutdown();
      },
    };
  }

  private oauthEventSubscription(manager: McpConnectionManager): () => void {
    return this.oauthService.onEvent((event) => {
      void this.handleMcpOAuthEvent(manager, event).catch((error: unknown) => {
        this.log.warn(`mcp oauth event handling failed: ${String(error)}`);
      });
    });
  }

  private async handleMcpOAuthEvent(
    manager: McpConnectionManager,
    event: McpOAuthEvent,
  ): Promise<void> {
    if (event.type === 'tokens-invalidated' && event.scope !== 'tokens' && event.scope !== 'all') {
      return;
    }
    const entry = manager.get(event.serverName);
    if (entry === undefined) return;
    const serverUrl = manager.getRemoteServerUrl(event.serverName);
    if (serverUrl === undefined || canonicalMcpOAuthResource(serverUrl) !== event.serverUrl) return;
    if (event.type === 'tokens-invalidated') {
      this.oauthService.forgetProvider(event.serverName, event.serverUrl);
    }
    if (entry.status === 'disabled' || entry.status === 'removed') return;
    if (entry.status === 'pending') {
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = (): void => {};
        let settled = false;
        const reconnect = (next: McpServerEntry | undefined): void => {
          if (settled) return;
          if (next !== undefined && (next.name !== event.serverName || next.status === 'pending')) {
            return;
          }
          settled = true;
          unsubscribe();
          if (next === undefined || next.status === 'disabled' || next.status === 'removed') {
            resolve();
            return;
          }
          void manager.reconnectAfterCurrent(event.serverName).then(resolve, reject);
        };
        unsubscribe = manager.onStatusChange(reconnect);
        if (settled) unsubscribe();
        else reconnect(manager.get(event.serverName));
      });
      return;
    }
    if (
      event.type === 'tokens-saved' &&
      entry.status !== 'needs-auth' &&
      entry.status !== 'failed'
    ) {
      return;
    }
    if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
    await manager.reconnectAndJoin(event.serverName);
  }

  private sessionBaseline(
    view: McpConnectionView,
    ready: Promise<void>,
    extra?: readonly string[],
  ): (name: string) => boolean {
    let baseline: Set<string> | undefined;
    let frozen = false;
    const snapshot = (): Set<string> => {
      if (baseline === undefined) {
        baseline = new Set<string>(extra);
        for (const entry of view.list()) {
          baseline.add(entry.name);
        }
      }
      return baseline;
    };
    void ready.then(
      () => {
        snapshot();
        frozen = true;
      },
      () => {
        snapshot();
        frozen = true;
      },
    );
    return (name) => {
      const names = snapshot();
      if (names.has(name)) return true;
      if (frozen) return false;
      if (view.get(name) === undefined) return false;
      names.add(name);
      return true;
    };
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.mcpConfig.ready;
    await this.identity.resolved();
    const servers = this.mcpConfig.servers();
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpServersChange): Promise<void> {
    return this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error) => {
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
