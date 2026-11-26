import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpServerEntry,
  type McpServerStatus,
} from '#/mcpCore/connection-manager';
import { McpOAuthService, type McpOAuthEvent } from '#/mcpCore/oauth/service';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { IProjectMcpService } from '#/project/projectMcp/projectMcp';
import { ProjectMcpService } from '#/project/projectMcp/projectMcpService';
import type { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import {
  IProjectMcpConfigService,
  type McpServersChange,
  type McpServersChangeEvent,
  type McpSourceServersChangeEvent,
  type McpTunables,
} from '#/project/projectMcpConfig/projectMcpConfig';

import { stubLog } from '../../_base/log/stubs';
import { registerAgentIdentityStub } from '../../app/agentIdentity/stubs';
import {
  createMemoryMcpOAuthStore,
  hostPathClass,
  ManualMcpOAuthScheduler,
  mockStdioServer,
  UNREACHABLE_SERVER_ORIGIN,
} from '../../mcpCore/stubs';

function stdioServer(): McpServerConfig {
  return {
    transport: 'stdio',
    ...mockStdioServer(),
    environment_id: 'local',
  };
}

describe('WorkspaceMcpService', () => {
  let cwd: string;
  let disposables: DisposableStore;
  let current: Record<string, McpServerConfig>;
  let tunablesValue: McpTunables;
  let tunablesFn: Mock<() => McpTunables>;
  let configChanges: AsyncEmitter<McpServersChangeEvent>;
  let sourceChanges: AsyncEmitter<McpSourceServersChangeEvent>;
  let tunablesChanges: Emitter<McpTunables>;
  let oauthService: McpOAuthService;
  let oauthScheduler: ManualMcpOAuthScheduler;
  let manager: MergedMcpConnectionView | undefined;
  let service: ProjectMcpService | undefined;
  let trackedSessions: Array<string | undefined>;
  let primaryDirs: IProjectDirs;
  let dirsChanges: Emitter<void>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-cwd-'));
    disposables = new DisposableStore();
    dirsChanges = disposables.add(new Emitter<void>());
    primaryDirs = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      primary: cwd,
      onDidChange: dirsChanges.event,
    } as unknown as IProjectDirs;
    current = {};
    trackedSessions = [];
    tunablesValue = {};
    tunablesFn = vi.fn(() => tunablesValue);
    configChanges = disposables.add(new AsyncEmitter<McpServersChangeEvent>());
    sourceChanges = disposables.add(new AsyncEmitter<McpSourceServersChangeEvent>());
    tunablesChanges = disposables.add(new Emitter<McpTunables>());
    oauthScheduler = new ManualMcpOAuthScheduler();
    oauthService = new McpOAuthService({
      store: createMemoryMcpOAuthStore(),
      scheduler: oauthScheduler,
    });
    manager = undefined;
    service = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service?.disposeAsync();
    await oauthService.dispose();
    disposables.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  function mcpConfigStub(): IProjectMcpConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      servers: () => current,
      sourceEntries: (id: string) => (id === 'workspace' ? current : {}),
      tunables: () => tunablesFn() as McpTunables,
      onDidChange: configChanges.event,
      onDidChangeSource: sourceChanges.event,
      onDidChangeTunables: tunablesChanges.event,
    };
  }

  async function fireChange(change: McpServersChange): Promise<void> {
    current = { ...current, ...change.upsert };
    for (const name of change.remove) delete current[name];
    const signal = new AbortController().signal;
    await Promise.all([
      configChanges.fireAsync(change, signal),
      sourceChanges.fireAsync({ sourceId: 'workspace', ...change }, signal),
    ]);
  }

  function createService(): IProjectMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IProjectContext, { cwd, workspaceId: 'test-workspace' });
        reg.defineInstance(IProjectDirs, primaryDirs);
        reg.defineInstance(IProjectMcpConfigService, mcpConfigStub());
        reg.definePartialInstance(IMcpOAuthService, oauthService);
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        const environment = Object.assign(
          new FakeEnvironment(
            { environmentId: 'local', generation: 'test-generation' },
            { capabilities: ['process'], pathClass: hostPathClass },
          ),
          { process: new HostProcessService() },
        );
        reg.definePartialInstance(IEnvironmentService, {
          _serviceBrand: undefined,
          inspect: () => environment,
          acquire: () => ({
            environment,
            track: <T,>(resource: T, sessionId?: string): T => {
              trackedSessions.push(sessionId);
              return resource;
            },
            dispose: () => {},
          }),
          acquireWhenReady: async () => ({
            environment,
            track: <T,>(resource: T, sessionId?: string): T => {
              trackedSessions.push(sessionId);
              return resource;
            },
            dispose: () => {},
          }),
        });
        registerAgentIdentityStub(reg);
        reg.define(IProjectMcpService, ProjectMcpService);
      },
    });
    service = ix.get(IProjectMcpService) as ProjectMcpService;
    return service;
  }

  it('connects the config snapshot in the initial load', async () => {
    current = { alpha: stdioServer(), beta: stdioServer() };
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const created = createService();
    manager = created.connectionManager();
    await created.ready;

    expect(connectAll).toHaveBeenCalledTimes(1);
    const connectedNames = connectAll.mock.calls.flatMap(([servers]) => Object.keys(servers ?? {}));
    expect(connectedNames.toSorted()).toEqual(['alpha', 'beta']);
  });

  it('reads timeout tunables from the config domain at connect and reschedules on retry changes', async () => {
    tunablesValue = { startupTimeoutMs: 4321, toolTimeoutMs: 9876 };
    current = { alpha: stdioServer() };

    const service = createService();
    manager = service.connectionManager();
    await service.ready;

    expect(manager.get('alpha')?.status).toBe('connected');
    expect(tunablesFn).toHaveBeenCalled();
    const reschedule = vi.spyOn(manager, 'rescheduleRetries');
    tunablesChanges.fire({ reconnectInitialDelayMs: 25, reconnectMaxDelayMs: 100 });
    expect(reschedule).toHaveBeenCalledTimes(1);
  }, 20000);

  it('applies upserts and removals from config change events', async () => {
    current = { alpha: stdioServer() };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    expect(manager.get('alpha')?.status).toBe('connected');

    await fireChange({ upsert: { beta: stdioServer() }, remove: ['alpha'] });

    expect(service.sourceManager('workspace')?.get('alpha')?.status).toBe('removed');
    expect(manager.get('alpha')).toBeUndefined();
    expect(manager.get('beta')?.status).toBe('connected');
  }, 20000);

  it('connects nothing from a config change still queued when the service is disposed', async () => {
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

    const applied = fireChange({ upsert: { beta: stdioServer() }, remove: [] });
    await (service as ProjectMcpService).disposeAsync();
    await applied;

    expect(spawn).not.toHaveBeenCalled();
    expect(manager.get('beta')).toBeUndefined();
  }, 20000);

  it('reconnects only default-cwd baseline stdio servers when primary changes', async () => {
    current = {
      defaulted: stdioServer(),
      explicit: { ...stdioServer(), cwd: '/explicit-cwd' } as McpServerConfig,
    };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    const reconnect = vi.spyOn(manager, 'reconnect').mockResolvedValue(undefined);

    Object.defineProperty(primaryDirs, 'primary', { get: () => '/next-primary' });
    dirsChanges.fire();

    await vi.waitFor(() => {
      expect(reconnect).toHaveBeenCalledWith('defaulted');
    });
    expect(reconnect).not.toHaveBeenCalledWith('explicit');
  });

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

    void fireChange({ upsert: { beta: stdioServer() }, remove: ['alpha'] });
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

  describe('credential events', () => {
    const SERVER_URL = `${UNREACHABLE_SERVER_ORIGIN}/mcp`;
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
