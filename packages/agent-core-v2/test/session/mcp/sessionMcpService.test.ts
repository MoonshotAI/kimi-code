import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IEnvironmentService } from '#/app/environment/environment';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpConnectionView,
} from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IProjectMcpService } from '#/project/projectMcp/projectMcp';
import { ProjectMcpService } from '#/project/projectMcp/projectMcpService';
import {
  IProjectMcpConfigService,
  type McpServersChangeEvent,
  type McpTunables,
} from '#/project/projectMcpConfig/projectMcpConfig';
import {
  MCP_SOURCE_PRIORITY,
  type McpSource,
} from '#/session/mcp/mcpSource';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import { SessionMcpService } from '#/session/mcp/sessionMcpService';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';

import { stubLog } from '../../_base/log/stubs';
import { registerAgentIdentityStub, stubAgentIdentity } from '../../app/agentIdentity/stubs';
import {
  createMemoryMcpOAuthStore,
  hostPathClass,
  ManualMcpOAuthScheduler,
  mockStdioServer,
  startEchoHttpMcpServer,
} from '../../mcpCore/stubs';

function stdioServer(): McpServerConfig {
  return {
    transport: 'stdio',
    ...mockStdioServer(),
    environment_id: 'local',
  };
}

describe('SessionMcpService', () => {
  let cwd: string;
  let disposables: DisposableStore;
  let current: Record<string, McpServerConfig>;
  let tunablesValue: McpTunables;
  let tunablesFn: Mock<() => McpTunables>;
  let configChanges: AsyncEmitter<McpServersChangeEvent>;
  let tunablesChanges: Emitter<McpTunables>;
  let oauthService: McpOAuthService;
  let oauthScheduler: ManualMcpOAuthScheduler;
  let manager: McpConnectionManager | undefined;
  let trackedSessions: Array<string | undefined>;
  let primaryDirs: IProjectDirs;
  let dirsChanges: Emitter<void>;
  let projectService: IProjectMcpService | undefined;
  let sessions: SessionMcpService[];
  let environmentServices: IEnvironmentService;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-cwd-'));
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
    tunablesChanges = disposables.add(new Emitter<McpTunables>());
    oauthScheduler = new ManualMcpOAuthScheduler();
    oauthService = new McpOAuthService({
      store: createMemoryMcpOAuthStore(),
      scheduler: oauthScheduler,
    });
    manager = undefined;
    projectService = undefined;
    sessions = [];
    const environment = Object.assign(
      new FakeEnvironment(
        { environmentId: 'local', generation: 'test-generation' },
        { capabilities: ['process'], pathClass: hostPathClass },
      ),
      { process: new HostProcessService() },
    );
    environmentServices = {
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
    } as unknown as IEnvironmentService;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sessions.map((session) => session.disposeAsync()));
    if (projectService !== undefined) await (projectService as ProjectMcpService).disposeAsync();
    await manager?.shutdown();
    await oauthService.dispose();
    disposables.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  function createProject(): IProjectMcpService {
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IProjectContext, { cwd, workspaceId: 'test-workspace' });
        reg.defineInstance(IProjectDirs, primaryDirs);
        reg.defineInstance(IProjectMcpConfigService, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          servers: () => current,
          tunables: () => tunablesFn() as McpTunables,
          onDidChange: configChanges.event,
          onDidChangeTunables: tunablesChanges.event,
        });
        reg.definePartialInstance(IMcpOAuthService, oauthService);
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(ITelemetryService, noopTelemetryService);
        reg.defineInstance(IEnvironmentService, environmentServices);
        registerAgentIdentityStub(reg);
        reg.define(IProjectMcpService, ProjectMcpService);
      },
    });
    projectService = ix.get(IProjectMcpService);
    manager = projectService.connectionManager();
    return projectService;
  }

  function createSession(
    source: McpSource,
    ephemeralServers: Record<string, McpServerConfig> = {},
    options: { sessionId?: string; sessionCwd?: string } = {},
  ): SessionMcpService {
    const sessionId = options.sessionId ?? 'session-1';
    const session = new SessionMcpService(
      makeSessionContext({
        sessionId,
        workspaceId: 'test-workspace',
        sessionDir: join(cwd, sessionId),
        sessionScope: `ws/${sessionId}`,
        cwd: options.sessionCwd ?? cwd,
      }),
      ephemeralServers,
      [source],
      { ready: Promise.resolve(), get: () => undefined } as unknown as IConfigService,
      oauthService,
      environmentServices,
      stubAgentIdentity(),
      stubLog(),
    );
    sessions.push(session);
    return session;
  }

  it('admits servers connecting before ready settles and freezes the baseline after', async () => {
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

    const project = createProject();
    const session = createSession(project.source());

    await vi.waitFor(() => {
      expect(manager?.get('alpha')).toBeDefined();
    });
    expect(session.isBaselineServer('alpha')).toBe(true);
    expect(session.isBaselineServer('ghost')).toBe(false);

    settleConnectAll();
    await project.ready;

    await manager?.connect('late', stdioServer());
    expect(session.isBaselineServer('late')).toBe(false);
    expect(session.isBaselineServer('alpha')).toBe(true);

    expect(createSession(project.source()).isBaselineServer('late')).toBe(true);
  }, 20000);

  it('admits servers that finished the initial load before the first baseline read', async () => {
    current = { alpha: stdioServer() };
    const project = createProject();
    const session = createSession(project.source());

    await project.ready;
    expect(manager?.get('alpha')?.status).toBe('connected');

    expect(session.isBaselineServer('alpha')).toBe(true);
  }, 20000);

  it('admits a needs-auth server that settled before the first baseline read', async () => {
    const server = await startEchoHttpMcpServer({ bearerToken: 'secret' });
    try {
      current = { remote: { transport: 'http', url: server.url } };
      const project = createProject();
      const session = createSession(project.source());

      await project.ready;
      expect(manager?.get('remote')?.status).toBe('needs-auth');

      expect(session.isBaselineServer('remote')).toBe(true);
    } finally {
      await server.close();
    }
  }, 20000);

  it('marks the ephemeral server names as baseline by construction', async () => {
    current = { base: stdioServer() };
    const project = createProject();
    await project.ready;

    const session = createSession(project.source(), { eph: stdioServer() });
    expect(session.isBaselineServer('eph')).toBe(true);
    expect(session.isBaselineServer('base')).toBe(true);

    await session.ready;
    expect(session.isBaselineServer('eph')).toBe(true);
    expect(session.isBaselineServer('late')).toBe(false);
  }, 20000);

  it('freezes the project baseline on project ready even while the overlay connect is pending', async () => {
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

    const project = createProject();
    await project.ready;

    const session = createSession(project.source(), { eph: stdioServer() });
    expect(session.isBaselineServer('eph')).toBe(true);
    expect(session.isBaselineServer('base')).toBe(true);

    await manager?.connect('late', stdioServer());
    expect(session.isBaselineServer('late')).toBe(false);

    settleOverlay();
    await session.ready;
    expect(session.isBaselineServer('late')).toBe(false);
    expect(session.isBaselineServer('eph')).toBe(true);
  }, 20000);

  it('connects ephemeral servers on a session-owned manager, released by session disposal', async () => {
    current = { base: stdioServer() };
    const project = createProject();
    await project.ready;

    const session = createSession(project.source(), { eph: stdioServer() });
    await session.ready;

    const view = session.connectionManager;
    expect(view.get('eph')?.status).toBe('connected');
    expect(view.get('base')?.status).toBe('connected');
    expect(manager?.get('eph')).toBeUndefined();
    expect(Object.keys(current)).toEqual(['base']);

    await session.disposeAsync();
    expect(view.get('eph')).toBeUndefined();
    expect(manager?.get('base')?.status).toBe('connected');
  }, 20000);

  it('starts no ephemeral server once disposed before its first load', async () => {
    const project = createProject();
    await project.ready;
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

    const session = createSession(project.source(), { eph: stdioServer() });
    await session.disposeAsync();
    await session.ready;

    expect(spawn).not.toHaveBeenCalled();
  });

  it('tags ephemeral stdio resources with the session id while project servers stay untagged', async () => {
    current = { base: stdioServer() };
    const project = createProject();
    await project.ready;

    const session = createSession(project.source(), { eph: stdioServer() });
    await session.ready;

    expect(new Set(trackedSessions)).toEqual(new Set([undefined, 'session-1']));
  }, 20000);

  it('uses the project source stdio cwd rather than the session cwd and skips empty overlays', async () => {
    const project = createProject();
    await project.ready;
    const sessionCwd = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-other-cwd-'));
    try {
      const empty = createSession(project.source(), {}, { sessionCwd });
      await empty.ready;
      const connectAll = vi.spyOn(McpConnectionManager.prototype, 'connectAll');
      const session = createSession(
        { ...project.source(), stdioCwd: () => cwd },
        { eph: stdioServer() },
        { sessionCwd },
      );
      await session.ready;
      expect(connectAll).toHaveBeenCalledTimes(1);
      expect(session.connectionManager.get('eph')?.status).toBe('connected');
    } finally {
      await rm(sessionCwd, { recursive: true, force: true });
    }
  }, 20000);

  it('detaching a registered shared source keeps its underlying connections alive', async () => {
    const sharedManager = new McpConnectionManager();
    await sharedManager.connect('shared', { transport: 'stdio', command: 'unused', enabled: false });
    const project = createProject();
    const session = createSession(project.source());
    const registration = session.registerSource({
      id: 'extra',
      priority: 50,
      ready: Promise.resolve(),
      view: sharedManager,
    });

    expect(session.connectionManager.get('shared')?.name).toBe('shared');
    registration.dispose();
    expect(session.connectionManager.get('shared')).toBeUndefined();
    expect(sharedManager.get('shared')?.name).toBe('shared');
    await sharedManager.shutdown();
  });

  it('does not admit sources registered after the baseline froze into the baseline', async () => {
    const project = createProject();
    const session = createSession(project.source());
    await session.ready;

    const lateManager = new McpConnectionManager();
    const connect = vi.spyOn(lateManager, 'connectAll').mockResolvedValue(undefined);
    await lateManager.connect('late', { transport: 'stdio', command: 'unused', enabled: false });
    session.registerSource({
      id: 'runtime',
      priority: MCP_SOURCE_PRIORITY.caller + 1,
      ready: Promise.resolve(),
      view: lateManager,
    });

    expect(session.connectionManager.get('late')?.name).toBe('late');
    expect(session.isBaselineServer('late')).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    await lateManager.shutdown();
  });

  it('releases a source registered after the session was disposed', async () => {
    const project = createProject();
    const session = createSession(project.source());
    await session.disposeAsync();
    const dispose = vi.fn();
    session.registerSource({
      id: 'late',
      priority: 1,
      ready: Promise.resolve(),
      view: new McpConnectionManager(),
      dispose,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('MergedMcpConnectionView', () => {
  let base: McpConnectionManager;
  let overlay: McpConnectionManager;
  let views: MergedMcpConnectionView[];

  beforeEach(() => {
    base = new McpConnectionManager();
    overlay = new McpConnectionManager();
    views = [];
  });

  afterEach(async () => {
    for (const view of views) view.dispose();
    await base.shutdown();
    await overlay.shutdown();
  });

  function disabledStdio(command: string): McpServerConfig {
    return { transport: 'stdio', command, enabled: false };
  }

  function createView(...layers: ReadonlyArray<readonly [string, number, McpConnectionView]>): MergedMcpConnectionView {
    const view = new MergedMcpConnectionView();
    views.push(view);
    for (const [id, priority, layerView] of layers) {
      view.addLayer({ id, priority, view: layerView });
    }
    return view;
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
    const view = createView(['base', 0, base], ['overlay', 100, overlay]);

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
    const view = createView(['base', 0, base], ['overlay', 100, overlay]);

    await expect(view.reconnect('shared')).resolves.toBeUndefined();
    await expect(view.reconnect('unknown')).rejects.toThrow('Unknown MCP server: unknown');

    await view.waitForInitialLoad();
    expect(view.initialLoadDurationMs()).toBe(0);
  });

  it('restores a shadowed lower-priority layer when the higher-priority layer is removed', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    await overlay.connect('shared', { transport: 'http', url: 'https://example.com/mcp', enabled: false });
    const view = createView(['base', 0, base]);
    const removeOverlay = view.addLayer({ id: 'overlay', priority: 100, view: overlay });

    expect(view.get('shared')?.transport).toBe('http');
    removeOverlay.dispose();
    expect(view.get('shared')?.transport).toBe('stdio');
  });
});
