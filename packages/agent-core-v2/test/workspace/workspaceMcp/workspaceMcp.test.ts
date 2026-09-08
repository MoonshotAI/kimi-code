import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpServerEntry,
  type McpServerStatus,
} from '#/mcpCore/connection-manager';
import { McpOAuthService, type McpOAuthEvent } from '#/mcpCore/oauth/service';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { SessionWillCreateEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
} from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';
import {
  IWorkspaceMcpConfigService,
  type McpServersChangeEvent,
  type McpTunables,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import { stubLog } from '../../_base/log/stubs';
import { registerAgentIdentityStub } from '../../app/agentIdentity/stubs';
import {
  createMemoryMcpOAuthStore,
  ManualMcpOAuthScheduler,
  startInProcessHttpMcpServer,
  stdioFixture,
} from '../../mcpCore/stubs';

function stdioServer(): McpServerConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [stdioFixture],
    runtime_id: 'local',
  };
}

describe('WorkspaceMcpService', () => {
  let cwd: string;
  let disposables: DisposableStore;
  let current: Record<string, McpServerConfig>;
  let tunablesValue: McpTunables;
  let tunablesFn: Mock<() => McpTunables>;
  let configChanges: AsyncEmitter<McpServersChangeEvent>;
  let assemblyEvents: Emitter<SessionWillCreateEvent>;
  let oauthService: McpOAuthService;
  let oauthScheduler: ManualMcpOAuthScheduler;
  let manager: InstanceType<typeof McpConnectionManager> | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-cwd-'));
    disposables = new DisposableStore();
    current = {};
    tunablesValue = {};
    tunablesFn = vi.fn(() => tunablesValue);
    configChanges = disposables.add(new AsyncEmitter<McpServersChangeEvent>());
    assemblyEvents = disposables.add(new Emitter<SessionWillCreateEvent>());
    oauthScheduler = new ManualMcpOAuthScheduler();
    oauthService = new McpOAuthService({
      store: createMemoryMcpOAuthStore(),
      scheduler: oauthScheduler,
    });
    manager = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager?.shutdown();
    await oauthService.dispose();
    disposables.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  function mcpConfigStub(): IWorkspaceMcpConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      servers: () => current,
      tunables: () => tunablesFn() as McpTunables,
      onDidChange: configChanges.event,
    };
  }

  function createService(): IWorkspaceMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IWorkspaceContext, { cwd, workspaceId: 'test-workspace' });
        reg.defineInstance(IWorkspaceMcpConfigService, mcpConfigStub());
        reg.definePartialInstance(IMcpOAuthService, oauthService);
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        const runtime = Object.assign(
          new FakeRuntime(
            { workspaceId: 'test-workspace', runtimeId: 'local', generation: 'test-generation' },
            { capabilities: ['process'] },
          ),
          { process: new HostProcessService() },
        );
        reg.defineInstance(IRuntimeResolver, {
          _serviceBrand: undefined,
          inspect: () => runtime,
          acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
        });
        reg.definePartialInstance(ISessionManager, {
          onWillCreateSession: assemblyEvents.event,
        });
        registerAgentIdentityStub(reg);
        reg.define(IWorkspaceMcpService, WorkspaceMcpService);
      },
    });
    return ix.get(IWorkspaceMcpService);
  }

  it('connects the config snapshot in the initial load', async () => {
    current = { alpha: stdioServer(), beta: stdioServer() };
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(Object.keys(connectAll.mock.calls[0]?.[0] ?? {}).toSorted()).toEqual(['alpha', 'beta']);
  });

  it('reads timeout tunables from the config domain at connect', async () => {
    tunablesValue = { startupTimeoutMs: 4321, toolTimeoutMs: 9876 };
    current = { alpha: stdioServer() };

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(manager.get('alpha')?.status).toBe('connected');
    expect(tunablesFn).toHaveBeenCalled();
  }, 20000);

  it('applies upserts and removals from config change events', async () => {
    current = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    await configChanges.fireAsync(
      { upsert: { beta: stdioServer() }, remove: ['alpha'] },
      new AbortController().signal,
    );

    expect(manager.get('alpha')?.status).toBe('removed');
    expect(manager.get('beta')?.status).toBe('connected');
  }, 20000);

  it('queues change events until the initial connect settles', async () => {
    current = { alpha: stdioServer() };
    let settleConnectAll: () => void = () => undefined;
    let signalConnectAllStarted: () => void = () => undefined;
    const connectAllStarted = new Promise<void>((resolve) => {
      signalConnectAllStarted = resolve;
    });
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          signalConnectAllStarted();
          settleConnectAll = resolve;
        }),
    );
    const connect = vi
      .spyOn(McpConnectionManager.prototype, 'connect')
      .mockResolvedValue(undefined as never);
    const markRemoved = vi
      .spyOn(McpConnectionManager.prototype, 'markRemoved')
      .mockResolvedValue(true as never);

    const service = createService();
    manager = service.connectionManager();

    void configChanges.fireAsync(
      { upsert: { beta: stdioServer() }, remove: ['alpha'] },
      new AbortController().signal,
    );
    await connectAllStarted;
    expect(connect).not.toHaveBeenCalled();
    expect(markRemoved).not.toHaveBeenCalled();

    settleConnectAll();
    await service.ready;
    await vi.waitFor(
      () => {
        expect(markRemoved).toHaveBeenCalledWith('alpha');
        expect(connect).toHaveBeenCalledWith('beta', stdioServer());
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('sessionHandle admits servers connecting before ready settles and freezes the baseline after', async () => {
    current = { alpha: stdioServer() };
    let settleConnectAll: () => void = () => undefined;
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(function (
      this: McpConnectionManager,
      servers: Readonly<Record<string, McpServerConfig>>,
    ) {
      for (const [name, config] of Object.entries(servers)) {
        void this.connect(name, config);
      }
      return new Promise<void>((resolve) => {
        settleConnectAll = resolve;
      });
    });

    const service = createService();
    manager = service.connectionManager();
    const handle = service.sessionHandle();

    await vi.waitFor(() => {
      expect(manager?.get('alpha')).toBeDefined();
    });
    expect(handle.isBaselineServer('alpha')).toBe(true);
    expect(handle.isBaselineServer('ghost')).toBe(false);

    settleConnectAll();
    await service.ready;

    await manager?.connect('late', stdioServer());
    expect(handle.isBaselineServer('late')).toBe(false);
    expect(handle.isBaselineServer('alpha')).toBe(true);

    expect(service.sessionHandle().isBaselineServer('late')).toBe(true);
  }, 20000);

  it('sessionHandle admits servers that finished the initial load before the first baseline read', async () => {
    current = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    const handle = service.sessionHandle();

    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    expect(handle.isBaselineServer('alpha')).toBe(true);
  }, 20000);

  it('sessionHandle admits a needs-auth server that settled before the first baseline read', async () => {
    const server = await startInProcessHttpMcpServer({ authToken: 'secret' });
    try {
      current = { remote: { transport: 'http', url: server.url } };
      const service = createService();
      manager = service.connectionManager();
      const handle = service.sessionHandle();

      await service.ready;
      expect(manager.get('remote')?.status).toBe('needs-auth');

      expect(handle.isBaselineServer('remote')).toBe(true);
    } finally {
      await server.close();
    }
  }, 20000);

  it('sessionOverlay marks the ephemeral server names as baseline by construction', async () => {
    current = { base: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const overlay = service.sessionOverlay({ eph: stdioServer() });
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);
    expect(overlay.handle.isBaselineServer('base')).toBe(true);

    await overlay.handle.ready;
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);
    expect(overlay.handle.isBaselineServer('late')).toBe(false);

    await overlay.shutdown();
  }, 20000);

  it('sessionOverlay freezes the workspace baseline on workspace ready even while the overlay connect is pending', async () => {
    current = { base: stdioServer() };
    let settleOverlay: () => void = () => undefined;
    vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(function (
      this: McpConnectionManager,
      servers: Readonly<Record<string, McpServerConfig>>,
    ) {
      if ('eph' in servers) {
        return new Promise<void>((resolve) => {
          settleOverlay = resolve;
        });
      }
      for (const [name, config] of Object.entries(servers)) {
        void this.connect(name, config);
      }
      return Promise.resolve();
    });

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const overlay = service.sessionOverlay({ eph: stdioServer() });
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);
    expect(overlay.handle.isBaselineServer('base')).toBe(true);

    await manager?.connect('late', stdioServer());
    expect(overlay.handle.isBaselineServer('late')).toBe(false);

    settleOverlay();
    await overlay.handle.ready;
    expect(overlay.handle.isBaselineServer('late')).toBe(false);
    expect(overlay.handle.isBaselineServer('eph')).toBe(true);

    await overlay.shutdown();
  }, 20000);

  it('sessionOverlay connects ephemeral servers on a session-owned manager, released by shutdown', async () => {
    current = { base: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    const overlay = service.sessionOverlay({ eph: stdioServer() });
    await overlay.handle.ready;

    const view = overlay.handle.connectionManager;
    expect(view.get('eph')?.status).toBe('connected');
    expect(view.get('base')?.status).toBe('connected');
    expect(manager?.get('eph')).toBeUndefined();
    expect(Object.keys(current)).toEqual(['base']);

    await overlay.shutdown();
    expect(view.get('eph')).toBeUndefined();
    expect(view.get('base')?.status).toBe('connected');
  }, 20000);

  describe('session overlay activation (onWillCreateSession)', () => {
    function willCreateEvent(
      servers: Record<string, McpServerConfig>,
      sessionCwd: string,
      workspaceId = 'test-workspace',
    ) {
      const seeds = new Map<unknown, unknown>([
        [ISessionEphemeralMcpServers, servers],
        [
          ISessionContext,
          makeSessionContext({
            sessionId: 's1',
            workspaceId,
            sessionDir: join(cwd, 's1'),
            sessionScope: 'ws/s1',
            cwd: sessionCwd,
          }),
        ],
      ]);
      const contributed = new Map<unknown, unknown>();
      const disposers: Array<() => void> = [];
      const event: SessionWillCreateEvent = {
        sessionId: 's1',
        readSeed: <T>(id: ServiceIdentifier<T>): T => seeds.get(id) as T,
        contributeSeed: (id, value) => {
          contributed.set(id, value);
        },
        onSessionDispose: (dispose) => {
          disposers.push(dispose);
        },
      };
      return { event, contributed, disposers };
    }

    it('creates the overlay from the will-create event, contributes the merged handle, and shuts it down with the session', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;

      const sessionCwd = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-cwd-'));
      const servers = { eph: stdioServer() };
      const sessionOverlay = vi.spyOn(service, 'sessionOverlay');
      const { event, contributed, disposers } = willCreateEvent(servers, sessionCwd);
      assemblyEvents.fire(event);

      expect(sessionOverlay).toHaveBeenCalledWith(servers, { stdioCwd: sessionCwd });
      const overlay = sessionOverlay.mock.results[0]?.value as ISessionMcpOverlay;
      expect(contributed.get(ISessionMcpHandle)).toBe(overlay.handle);
      await overlay.handle.ready;
      expect(overlay.handle.connectionManager.get('eph')?.status).toBe('connected');

      const shutdown = vi.spyOn(overlay, 'shutdown');
      expect(disposers).toHaveLength(1);
      disposers[0]!();
      expect(shutdown).toHaveBeenCalledTimes(1);
      await shutdown.mock.results[0]?.value;
      await rm(sessionCwd, { recursive: true, force: true });
    }, 20000);

    it('ignores a session created without ephemeral servers', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;

      const sessionOverlay = vi.spyOn(service, 'sessionOverlay');
      const { event, contributed, disposers } = willCreateEvent({}, cwd);
      assemblyEvents.fire(event);

      expect(sessionOverlay).not.toHaveBeenCalled();
      expect(contributed.size).toBe(0);
      expect(disposers).toHaveLength(0);
    });

    it('ignores a will-create event of a session belonging to another workspace', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;

      const sessionOverlay = vi.spyOn(service, 'sessionOverlay');
      const { event, contributed, disposers } = willCreateEvent(
        { eph: stdioServer() },
        cwd,
        'other-workspace',
      );
      assemblyEvents.fire(event);

      expect(sessionOverlay).not.toHaveBeenCalled();
      expect(contributed.size).toBe(0);
      expect(disposers).toHaveLength(0);
    });
  });

  describe('credential events', () => {
    const SERVER_URL = 'https://mcp.example.test/mcp';
    let httpServers: HttpServer[] = [];

    afterEach(async () => {
      const servers = httpServers;
      httpServers = [];
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((err) => {
                if (err) {
                  reject(err);
                  return;
                }
                resolve();
              });
            }),
        ),
      );
    });

    function mockManagerEntry(
      status: McpServerStatus,
      url: string = SERVER_URL,
    ): Mock<(name: string) => Promise<void>> {
      vi.spyOn(McpConnectionManager.prototype, 'get').mockReturnValue({
        name: 'notion',
        transport: 'http',
        status,
        toolCount: 0,
      });
      vi.spyOn(McpConnectionManager.prototype, 'getRemoteServerUrl').mockReturnValue(url);
      return vi
        .spyOn(McpConnectionManager.prototype, 'reconnectAndJoin')
        .mockResolvedValue(undefined);
    }

    async function startRefreshFailingServer(): Promise<{
      origin: string;
      counts: { refresh: number };
    }> {
      const counts = { refresh: 0 };
      const server: HttpServer = createHttpServer((req, res) => {
        if (req.method === 'POST' && req.url === '/token') {
          counts.refresh += 1;
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('broken');
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      httpServers.push(server);
      const port = (server.address() as HttpAddress).port;
      return { origin: `http://127.0.0.1:${port}`, counts };
    }

    async function seedOAuthServerState(authServerOrigin: string): Promise<void> {
      const provider = oauthService.getProvider('notion', SERVER_URL);
      await provider.ready;
      await provider.saveDiscoveryState({
        authorizationServerUrl: authServerOrigin,
        authorizationServerMetadata: {
          issuer: authServerOrigin,
          authorization_endpoint: `${authServerOrigin}/authorize`,
          token_endpoint: `${authServerOrigin}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
        },
      });
      await provider.saveClientInformation({
        client_id: 'cached-client',
        redirect_uris: ['http://127.0.0.1:45678/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      } satisfies OAuthClientInformationFull);
    }

    it('reconnects a needs-auth entry when tokens are saved', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('needs-auth');

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });

      await vi.waitFor(() => {
        expect(reconnectAndJoin).toHaveBeenCalledWith('notion');
      });
    });

    it('leaves a connected entry alone when tokens are saved', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('connected');

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });

      expect(reconnectAndJoin).not.toHaveBeenCalled();
    });

    it('forgets the provider and reconnects a connected entry on token invalidation', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('connected');
      const forgetProvider = vi.spyOn(oauthService, 'forgetProvider');

      await oauthService.invalidate('notion', SERVER_URL, 'all');

      await vi.waitFor(() => {
        expect(reconnectAndJoin).toHaveBeenCalledWith('notion');
      });
      expect(forgetProvider).toHaveBeenCalledWith('notion', SERVER_URL);
    });

    it('ignores a credential event for a different server URL', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('needs-auth', 'https://other.example.test/mcp');
      const forgetProvider = vi.spyOn(oauthService, 'forgetProvider');

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });

      expect(reconnectAndJoin).not.toHaveBeenCalled();
      expect(forgetProvider).not.toHaveBeenCalled();
    });

    it('defers the reconnect of a pending entry until its initial connect settles', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      mockManagerEntry('pending');
      const reconnectAfterCurrent = vi
        .spyOn(McpConnectionManager.prototype, 'reconnectAfterCurrent')
        .mockResolvedValue(undefined);
      let notifyStatus: ((entry: McpServerEntry) => void) | undefined;
      vi.spyOn(McpConnectionManager.prototype, 'onStatusChange').mockImplementation(
        (listener) => {
          notifyStatus = listener;
          return () => undefined;
        },
      );

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });
      expect(reconnectAfterCurrent).not.toHaveBeenCalled();

      notifyStatus?.({ name: 'notion', transport: 'http', status: 'connected', toolCount: 0 });
      await vi.waitFor(() => {
        expect(reconnectAfterCurrent).toHaveBeenCalledWith('notion');
      });
    });

    it('reconnects when a pending entry settles before the status listener is attached', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      vi.spyOn(McpConnectionManager.prototype, 'get')
        .mockReturnValueOnce({
          name: 'notion',
          transport: 'http',
          status: 'pending',
          toolCount: 0,
        })
        .mockReturnValue({
          name: 'notion',
          transport: 'http',
          status: 'needs-auth',
          toolCount: 0,
        });
      vi.spyOn(McpConnectionManager.prototype, 'getRemoteServerUrl').mockReturnValue(SERVER_URL);
      vi.spyOn(McpConnectionManager.prototype, 'onStatusChange').mockReturnValue(() => undefined);
      const reconnectAfterCurrent = vi
        .spyOn(McpConnectionManager.prototype, 'reconnectAfterCurrent')
        .mockResolvedValue(undefined);

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });

      await vi.waitFor(() => {
        expect(reconnectAfterCurrent).toHaveBeenCalledWith('notion');
      });
    });

    it('ignores a client-scope invalidation as flow-local churn', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('connected');
      const forgetProvider = vi.spyOn(oauthService, 'forgetProvider');

      const provider = oauthService.getProvider('notion', SERVER_URL);
      await provider.ready;
      await provider.clearCredentials('client');

      expect(reconnectAndJoin).not.toHaveBeenCalled();
      expect(forgetProvider).not.toHaveBeenCalled();
    });

    it('ignores a discovery-scope invalidation as flow-local churn', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('connected');
      const forgetProvider = vi.spyOn(oauthService, 'forgetProvider');

      const provider = oauthService.getProvider('notion', SERVER_URL);
      await provider.ready;
      await provider.clearCredentials('discovery');

      expect(reconnectAndJoin).not.toHaveBeenCalled();
      expect(forgetProvider).not.toHaveBeenCalled();
    });

    it('reconnects a connected entry when a proactive refresh fails', async () => {
      const authServer = await startRefreshFailingServer();
      await seedOAuthServerState(authServer.origin);
      const service = createService();
      manager = service.connectionManager();
      await service.ready;

      await oauthService.getProvider('notion', SERVER_URL).saveTokens({
        access_token: 'stale-access-token',
        refresh_token: 'stale-refresh-token',
        token_type: 'Bearer',
        expires_in: 60,
      });
      const reconnectAndJoin = mockManagerEntry('connected');

      await oauthScheduler.advanceBy(30_000);
      expect(reconnectAndJoin).toHaveBeenCalledWith('notion');
      expect(authServer.counts.refresh).toBe(1);
    }, 15000);

    it('ignores a failed proactive refresh for a needs-auth entry', async () => {
      const authServer = await startRefreshFailingServer();
      await seedOAuthServerState(authServer.origin);
      const events: McpOAuthEvent[] = [];
      oauthService.onEvent((event) => events.push(event));
      const service = createService();
      manager = service.connectionManager();
      await service.ready;

      await oauthService.getProvider('notion', SERVER_URL).saveTokens({
        access_token: 'stale-access-token',
        refresh_token: 'stale-refresh-token',
        token_type: 'Bearer',
        expires_in: 60,
      });
      const reconnectAndJoin = mockManagerEntry('needs-auth');

      await oauthScheduler.advanceBy(30_000);
      expect(events.some((event) => event.type === 'refresh-failed')).toBe(true);
      expect(reconnectAndJoin).not.toHaveBeenCalled();
    }, 15000);

    it('does not reconnect a disabled entry when tokens are saved', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('disabled');

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });

      expect(reconnectAndJoin).not.toHaveBeenCalled();
    });

    it('does not reconnect a removed entry when tokens are saved', async () => {
      const service = createService();
      manager = service.connectionManager();
      await service.ready;
      const reconnectAndJoin = mockManagerEntry('removed');

      await oauthService
        .getProvider('notion', SERVER_URL)
        .saveTokens({ access_token: 'a', token_type: 'Bearer' });

      expect(reconnectAndJoin).not.toHaveBeenCalled();
    });
  });
});

describe('MergedMcpConnectionView', () => {
  let base: McpConnectionManager;
  let overlay: McpConnectionManager;

  beforeEach(() => {
    base = new McpConnectionManager();
    overlay = new McpConnectionManager();
  });

  afterEach(async () => {
    await base.shutdown();
    await overlay.shutdown();
  });

  function disabledStdio(command: string): McpServerConfig {
    return { transport: 'stdio', command, enabled: false };
  }

  it('shadows same-named base entries with overlay entries and filters their statuses', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    await base.connect('base-only', disabledStdio('base-cmd'));
    await overlay.connect('shared', {
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    await overlay.connect('eph', disabledStdio('eph-cmd'));
    const view = new MergedMcpConnectionView(base, overlay, new Set(['shared', 'eph']));

    expect(
      view
        .list()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['base-only', 'eph', 'shared']);
    expect(view.get('shared')?.transport).toBe('http');
    expect(view.get('base-only')?.transport).toBe('stdio');

    const seen: string[] = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push(entry.name));
    await base.connect('shared', disabledStdio('base-cmd'));
    await base.connect('base-only', disabledStdio('base-cmd'));
    await overlay.connect('shared', {
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    unsubscribe();

    expect(seen).toEqual(['base-only', 'shared']);
  });

  it('routes reconnect to the name owner and aggregates initial-load readiness', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    await overlay.connect('shared', { transport: 'http', url: 'http://127.0.0.1:1/mcp' });
    expect(overlay.get('shared')?.status).toBe('failed');
    const view = new MergedMcpConnectionView(base, overlay, new Set(['shared']));

    await expect(view.reconnect('shared')).resolves.toBeUndefined();
    await expect(view.reconnect('unknown')).rejects.toThrow('Unknown MCP server: unknown');

    await view.waitForInitialLoad();
    expect(view.initialLoadDurationMs()).toBe(0);
  });
});
