import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { AsyncEmitter, Emitter, type IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpServerEntry,
  type McpServerStatus,
} from '#/mcpCore/connection-manager';
import { McpOAuthService, type McpOAuthEvent } from '#/mcpCore/oauth/service';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { IEnvironmentService } from '#/app/environment/environment';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import {
  WorkspaceMcpService,
  type McpSuppression,
} from '#/workspace/workspaceMcp/workspaceMcpService';
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
  stdioFixture,
} from '../../mcpCore/stubs';

function stdioServer(): McpServerConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [stdioFixture],
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
  let tunablesChanges: Emitter<McpTunables>;
  let oauthService: McpOAuthService;
  let oauthScheduler: ManualMcpOAuthScheduler;
  let manager: InstanceType<typeof McpConnectionManager> | undefined;
  let stdioCwd: string;
  let stdioCwdChanges: Emitter<void>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-cwd-'));
    disposables = new DisposableStore();
    stdioCwd = cwd;
    stdioCwdChanges = disposables.add(new Emitter<void>());
    current = {};
    tunablesValue = {};
    tunablesFn = vi.fn(() => tunablesValue);
    configChanges = disposables.add(new AsyncEmitter<McpServersChangeEvent>());
    tunablesChanges = disposables.add(new Emitter<McpTunables>());
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
      onDidChangeTunables: tunablesChanges.event,
    };
  }

  function createService(suppression?: McpSuppression): IWorkspaceMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IWorkspaceMcpConfigService, mcpConfigStub());
        reg.definePartialInstance(IMcpOAuthService, oauthService);
        reg.defineInstance(ILogService, stubLog());
        const environment = Object.assign(
          new FakeEnvironment(
            { environmentId: 'local', generation: 'test-generation' },
            { capabilities: ['process'] },
          ),
          { process: new HostProcessService() },
        );
        reg.definePartialInstance(IEnvironmentService, {
          _serviceBrand: undefined,
          inspect: () => environment,
          acquire: () => ({ environment, track: <T,>(resource: T): T => resource, dispose: () => {} }),
          acquireWhenReady: async () => ({
            environment,
            track: <T,>(resource: T): T => resource,
            dispose: () => {},
          }),
        });
        registerAgentIdentityStub(reg);
      },
    });
    ix.set(
      IWorkspaceMcpService,
      new SyncDescriptor(WorkspaceMcpService, [
        { stdioCwd: () => stdioCwd, onDidChangeStdioCwd: stdioCwdChanges.event, suppression },
      ]),
    );
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

    await configChanges.fireAsync(
      { upsert: { beta: stdioServer() }, remove: ['alpha'] },
      new AbortController().signal,
    );

    expect(manager.get('alpha')?.status).toBe('removed');
    expect(manager.get('beta')?.status).toBe('connected');
  }, 20000);

  it('reconnects only default-cwd baseline stdio servers when the stdio cwd changes', async () => {
    current = {
      defaulted: stdioServer(),
      explicit: { ...stdioServer(), cwd: '/explicit-cwd' } as McpServerConfig,
    };
    const service = createService();
    manager = service.connectionManager();
    await service.ready;
    const reconnect = vi.spyOn(manager, 'reconnect').mockResolvedValue(undefined);

    stdioCwd = '/next-primary';
    stdioCwdChanges.fire();

    await vi.waitFor(() => {
      expect(reconnect).toHaveBeenCalledWith('defaulted');
    });
    expect(reconnect).not.toHaveBeenCalledWith('explicit');
  });

  describe('suppression', () => {
    function suppressionOf(initial: readonly string[]): McpSuppression & {
      set(names: readonly string[]): Promise<void>;
      settle(): void;
    } {
      let names: ReadonlySet<string> = new Set(initial);
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const changes = disposables.add(new AsyncEmitter<IWaitUntil>());
      return {
        settled: () => settled,
        current: () => names,
        onDidChange: changes.event,
        set: (next) => {
          names = new Set(next);
          return changes.fireAsync({}, new AbortController().signal);
        },
        settle: () => settle(),
      };
    }

    it('connects only unsuppressed names once suppression settles', async () => {
      current = { alpha: stdioServer(), beta: stdioServer() };
      const connectAll = vi
        .spyOn(McpConnectionManager.prototype, 'connectAll')
        .mockResolvedValue(undefined);
      const suppression = suppressionOf(['beta']);

      const service = createService(suppression);
      manager = service.connectionManager();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(connectAll).not.toHaveBeenCalled();

      suppression.settle();
      await service.ready;

      expect(connectAll).toHaveBeenCalledTimes(1);
      expect(Object.keys(connectAll.mock.calls[0]?.[0] ?? {})).toEqual(['alpha']);
      expect([...service.definedNames()].toSorted()).toEqual(['alpha', 'beta']);
    });

    it('removes newly suppressed names, reconnects released ones, and skips suppressed upserts', async () => {
      current = { alpha: stdioServer(), beta: stdioServer() };
      vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockResolvedValue(undefined);
      const connect = vi
        .spyOn(McpConnectionManager.prototype, 'connect')
        .mockResolvedValue(undefined as never);
      const markRemoved = vi
        .spyOn(McpConnectionManager.prototype, 'markRemoved')
        .mockResolvedValue(true as never);
      const suppression = suppressionOf([]);
      suppression.settle();
      const service = createService(suppression);
      manager = service.connectionManager();
      await service.ready;

      await suppression.set(['alpha']);
      expect(markRemoved).toHaveBeenCalledWith('alpha');
      await configChanges.fireAsync(
        { upsert: { alpha: stdioServer(), gamma: stdioServer() }, remove: [] },
        new AbortController().signal,
      );
      expect(connect).toHaveBeenCalledWith('gamma', stdioServer());
      expect(connect).not.toHaveBeenCalledWith('alpha', expect.anything());

      await suppression.set([]);
      expect(connect).toHaveBeenCalledWith('alpha', stdioServer());
    });

    it('starts every released name before any of their connections finishes', async () => {
      current = { alpha: stdioServer(), beta: stdioServer() };
      vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockResolvedValue(undefined);
      const pending: (() => void)[] = [];
      const connect = vi
        .spyOn(McpConnectionManager.prototype, 'connect')
        .mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
      const suppression = suppressionOf(['alpha', 'beta']);
      suppression.settle();
      const service = createService(suppression);
      manager = service.connectionManager();
      await service.ready;

      const applied = suppression.set([]);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      expect(connect.mock.calls.map(([name]) => name).toSorted()).toEqual(['alpha', 'beta']);

      for (const resolve of pending) resolve();
      await applied;
    });
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
