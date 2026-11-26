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
import { RefCountedMcpServerPool } from '#/mcpCore/refCountedPool';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';
import { IProjectMcpService } from '#/project/projectMcp/projectMcp';
import { ProjectMcpService } from '#/project/projectMcp/projectMcpService';
import {
  IProjectMcpConfigService,
  type McpServersChangeEvent,
  type McpSourceServersChangeEvent,
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
  let sourceChanges: AsyncEmitter<McpSourceServersChangeEvent>;
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
    sourceChanges = disposables.add(new AsyncEmitter<McpSourceServersChangeEvent>());
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
          sourceEntries: (id: string) => (id === 'workspace' ? current : {}),
          tunables: () => tunablesFn() as McpTunables,
          onDidChange: configChanges.event,
          onDidChangeSource: sourceChanges.event,
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
    manager = projectService.sources().find((source) => source.id === 'workspace')?.view as
      | McpConnectionManager
      | undefined;
    return projectService;
  }

  function createSession(
    sources: readonly McpSource[],
    ephemeralServers: Record<string, McpServerConfig> = {},
    options: { sessionId?: string; sessionCwd?: string; disabledSources?: readonly string[] } = {},
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
      sources,
      options.disabledSources ?? [],
      { ready: Promise.resolve(), get: () => undefined } as unknown as IConfigService,
      oauthService,
      environmentServices,
      stubAgentIdentity(),
      stubLog(),
    );
    sessions.push(session);
    return session;
  }

  it('freezes the baseline from startup configs even while initial connections are still pending', async () => {
    current = { alpha: stdioServer() };
    let settleConnect: () => void = () => undefined;
    let signalConnectStarted: () => void = () => undefined;
    const connectStarted = new Promise<void>((resolve) => {
      signalConnectStarted = resolve;
    });
    vi.spyOn(McpConnectionManager.prototype, 'connect').mockImplementation(async () => {
      signalConnectStarted();
      await new Promise<void>((resolve) => {
        settleConnect = resolve;
      });
    });

    const project = createProject();
    const session = createSession(project.sources());
    try {
      await connectStarted;

      expect(session.isBaselineServer('alpha')).toBe(true);
      expect(session.isBaselineServer('ghost')).toBe(false);
      expect(session.isBaselineServer('late')).toBe(false);
    } finally {
      settleConnect();
    }
    await session.ready;
    expect(session.isBaselineServer('alpha')).toBe(true);
    expect(session.isBaselineServer('late')).toBe(false);
  }, 20000);

  it('admits servers that finished the initial load before the first baseline read', async () => {
    current = { alpha: stdioServer() };
    const project = createProject();
    const session = createSession(project.sources());

    await session.ready;
    expect(manager?.get('alpha')?.status).toBe('connected');

    expect(session.isBaselineServer('alpha')).toBe(true);
  }, 20000);

  it('admits a needs-auth server that settled before the first baseline read', async () => {
    const server = await startEchoHttpMcpServer({ bearerToken: 'secret' });
    try {
      current = { remote: { transport: 'http', url: server.url } };
      const project = createProject();
      const session = createSession(project.sources());

      await session.ready;
      expect(manager?.get('remote')?.status).toBe('needs-auth');

      expect(session.isBaselineServer('remote')).toBe(true);
    } finally {
      await server.close();
    }
  }, 20000);

  it('upserts runtime servers for this session only without entering the baseline', async () => {
    current = { alpha: stdioServer() };
    const project = createProject();
    const first = createSession(project.sources());
    const second = createSession(project.sources());
    await first.ready;
    await second.ready;

    await first.upsertServer('alpha', { transport: 'http', url: 'https://127.0.0.1:9/mcp' });
    await first.upsertServer('extra', { transport: 'http', url: 'https://127.0.0.1:9/mcp' });

    expect(first.connectionManager.get('alpha')?.transport).toBe('http');
    expect(first.connectionManager.get('extra')?.transport).toBe('http');
    expect(first.isBaselineServer('extra')).toBe(false);
    expect(second.connectionManager.get('alpha')?.transport).toBe('stdio');
    expect(second.connectionManager.get('extra')).toBeUndefined();
  }, 20000);

  it('marks the ephemeral server names as baseline by construction', async () => {
    current = { base: stdioServer() };
    const project = createProject();
    await project.ready;

    const session = createSession(project.sources(), { eph: stdioServer() });
    expect(session.isBaselineServer('eph')).toBe(true);
    expect(session.isBaselineServer('base')).toBe(true);

    await session.ready;
    expect(session.isBaselineServer('eph')).toBe(true);
    expect(session.isBaselineServer('late')).toBe(false);
  }, 20000);

  it('connects ephemeral servers on a session-owned manager, released by session disposal', async () => {
    current = { base: stdioServer() };
    const project = createProject();
    await project.ready;

    const session = createSession(project.sources(), { eph: stdioServer() });
    await session.ready;

    const view = session.connectionManager;
    expect(view.get('eph')?.status).toBe('connected');
    expect(view.get('base')?.status).toBe('connected');
    expect(manager?.get('eph')).toBeUndefined();
    expect(Object.keys(current)).toEqual(['base']);

    await session.disposeAsync();
    expect(view.get('eph')).toBeUndefined();
    expect(manager?.get('base')).toBeUndefined();
  }, 20000);

  it('starts no ephemeral server once disposed before its first load', async () => {
    const project = createProject();
    await project.ready;
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

    const session = createSession(project.sources(), { eph: stdioServer() });
    await session.disposeAsync();
    await session.ready;

    expect(spawn).not.toHaveBeenCalled();
  });

  it('tags ephemeral stdio resources with the session id while project servers stay untagged', async () => {
    current = { base: stdioServer() };
    const project = createProject();
    await project.ready;

    const session = createSession(project.sources(), { eph: stdioServer() });
    await session.ready;

    expect(new Set(trackedSessions)).toEqual(new Set([undefined, 'session-1']));
  }, 20000);

  it('uses the project source stdio cwd rather than the session cwd and skips empty overlays', async () => {
    const project = createProject();
    await project.ready;
    const sessionCwd = mkdtempSync(join(tmpdir(), 'kimi-session-mcp-other-cwd-'));
    try {
      const empty = createSession(project.sources(), {}, { sessionCwd });
      await empty.ready;
      const connect = vi.spyOn(McpConnectionManager.prototype, 'connect');
      const session = createSession(
        project.sources().map((source) => ({ ...source, stdioCwd: () => cwd })),
        { eph: stdioServer() },
        { sessionCwd },
      );
      await session.ready;
      expect(connect).toHaveBeenCalledTimes(1);
      expect(session.connectionManager.get('eph')?.status).toBe('connected');
    } finally {
      await rm(sessionCwd, { recursive: true, force: true });
    }
  }, 20000);

  it('detaching a registered shared source keeps its underlying connections alive', async () => {
    const sharedManager = new McpConnectionManager();
    await sharedManager.connect('shared', { transport: 'stdio', command: 'unused', enabled: false });
    const project = createProject();
    const session = createSession(project.sources());
    const registration = session.registerSource({
      id: 'extra',
      priority: 50,
      ready: Promise.resolve(),
      view: sharedManager,
      entries: () => ({ shared: { transport: 'stdio', command: 'unused', enabled: false } }),
    });

    expect(session.connectionManager.get('shared')?.name).toBe('shared');
    registration.dispose();
    expect(session.connectionManager.get('shared')?.status).toBe('removed');
    expect(sharedManager.get('shared')?.name).toBe('shared');
    await sharedManager.shutdown();
  });

  it('does not admit sources registered after the baseline froze into the baseline', async () => {
    const project = createProject();
    const session = createSession(project.sources());
    await session.ready;

    const lateManager = new McpConnectionManager();
    const connect = vi.spyOn(lateManager, 'connectAll').mockResolvedValue(undefined);
    await lateManager.connect('late', { transport: 'stdio', command: 'unused', enabled: false });
    session.registerSource({
      id: 'runtime',
      priority: MCP_SOURCE_PRIORITY.caller + 1,
      ready: Promise.resolve(),
      view: lateManager,
      entries: () => ({ late: { transport: 'stdio', command: 'unused', enabled: false } }),
    });

    expect(session.connectionManager.get('late')?.name).toBe('late');
    expect(session.isBaselineServer('late')).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    await lateManager.shutdown();
  });

  it('releases a source registered after the session was disposed', async () => {
    const project = createProject();
    const session = createSession(project.sources());
    await session.disposeAsync();
    const dispose = vi.fn();
    session.registerSource({
      id: 'late',
      priority: 1,
      ready: Promise.resolve(),
      view: new McpConnectionManager(),
      entries: () => ({}),
      dispose,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disabling a source lets a lower-priority source take over and re-enabling shadows it again', async () => {
    const userManager = new McpConnectionManager();
    const workspaceManager = new McpConnectionManager();
    await userManager.connect('shared', {
      transport: 'http',
      url: 'https://user.example.test/mcp',
      enabled: false,
    });
    await workspaceManager.connect('shared', {
      transport: 'http',
      url: 'https://workspace.example.test/mcp',
      enabled: false,
    });
    const session = createSession([
      {
        id: 'user',
        priority: MCP_SOURCE_PRIORITY.user,
        ready: Promise.resolve(),
        view: userManager,
        entries: () => ({
          shared: { transport: 'http', url: 'https://user.example.test/mcp', enabled: false },
        }),
      },
      {
        id: 'workspace',
        priority: MCP_SOURCE_PRIORITY.workspace,
        ready: Promise.resolve(),
        view: workspaceManager,
        entries: () => ({
          shared: { transport: 'http', url: 'https://workspace.example.test/mcp', enabled: false },
        }),
      },
    ]);
    await session.ready;

    expect(session.connectionManager.getRemoteServerUrl('shared')).toBe('https://workspace.example.test/mcp');
    session.setSourceEnabled('workspace', false);
    expect(session.isSourceEnabled('workspace')).toBe(false);
    expect(session.connectionManager.getRemoteServerUrl('shared')).toBe('https://user.example.test/mcp');
    expect(session.listSources().map((source) => [source.id, source.enabled])).toEqual([
      ['user', true],
      ['workspace', false],
    ]);

    session.setSourceEnabled('workspace', true);
    expect(session.connectionManager.getRemoteServerUrl('shared')).toBe('https://workspace.example.test/mcp');
    await userManager.shutdown();
    await workspaceManager.shutdown();
  });

  it('honors disabled sources from session options', async () => {
    const userManager = new McpConnectionManager();
    const rootManager = new McpConnectionManager();
    await userManager.connect('srv', { transport: 'stdio', command: 'user-cmd', enabled: false });
    await rootManager.connect('srv', { transport: 'stdio', command: 'root-cmd', enabled: false });
    const session = createSession(
      [
        {
          id: 'user',
          priority: MCP_SOURCE_PRIORITY.user,
          ready: Promise.resolve(),
          view: userManager,
          entries: () => ({ srv: { transport: 'stdio', command: 'user-cmd', enabled: false } }),
        },
        {
          id: 'project-root',
          priority: MCP_SOURCE_PRIORITY['project-root'],
          ready: Promise.resolve(),
          view: rootManager,
          entries: () => ({ srv: { transport: 'stdio', command: 'root-cmd', enabled: false } }),
        },
      ],
      {},
      { disabledSources: ['project-root'] },
    );
    await session.ready;

    expect(session.isSourceEnabled('project-root')).toBe(false);
    await expect(session.connectionManager.reconnect('srv')).rejects.toThrow('MCP server is disabled: srv');
    await userManager.shutdown();
    await rootManager.shutdown();
  });

  it('projects higher-priority partial overrides as cross-source disable vetoes and disclosure overrides', async () => {
    const userManager = new McpConnectionManager({
      environmentResolver: environmentServices,
      environmentId: 'local',
      stdioCwd: () => cwd,
    });
    await userManager.connect('off', stdioServer());
    await userManager.connect('tuned', stdioServer());
    let overrideEntries: Record<string, { enabled?: boolean; deferred?: boolean; disabledTools?: string[] }> = {
      off: { enabled: false },
      tuned: { deferred: false, disabledTools: ['echo'] },
    };
    const overrideChanges = new Emitter<void>();
    const workspaceManager = new McpConnectionManager();
    const session = createSession([
      {
        id: 'user',
        priority: MCP_SOURCE_PRIORITY.user,
        ready: Promise.resolve(),
        view: userManager,
        entries: () => ({
          off: stdioServer(),
          tuned: { ...stdioServer(), deferred: true },
        }),
      },
      {
        id: 'workspace',
        priority: MCP_SOURCE_PRIORITY.workspace,
        ready: Promise.resolve(),
        view: workspaceManager,
        entries: () => overrideEntries,
        onDidChangeEntries: overrideChanges.event,
      },
    ]);
    await session.ready;

    expect(session.connectionManager.get('off')?.status).toBe('disabled');
    expect(session.connectionManager.resolved('off')).toBeUndefined();
    await expect(session.connectionManager.reconnect('off')).rejects.toThrow('MCP server is disabled: off');
    expect(session.connectionManager.deferredOf('tuned')).toBe(false);
    const enabledNames = [...(session.connectionManager.resolved('tuned')?.enabledNames ?? [])];
    expect(enabledNames).toContain('boom');
    expect(enabledNames).not.toContain('echo');
    expect(workspaceManager.list()).toEqual([]);

    overrideEntries = {};
    overrideChanges.fire();
    expect(session.connectionManager.get('off')?.status).toBe('connected');
    expect(session.connectionManager.deferredOf('tuned')).toBe(true);
    await userManager.shutdown();
    await workspaceManager.shutdown();
  }, 20000);

  it('reconnects a shared server when its config changes and marks it removed when deleted', async () => {
    current = { alpha: stdioServer() };
    const project = createProject();
    const session = createSession(project.sources());
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    await session.ready;
    expect(session.connectionManager.get('alpha')?.status).toBe('connected');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [firstChild] = await Promise.all(spawn.mock.results.map((result) => result.value));

    const updated: McpServerConfig = {
      transport: 'stdio',
      ...mockStdioServer(),
      environment_id: 'local',
      env: { KIMI_TEST_TAG: 'v2' },
    };
    current = { alpha: updated };
    const signal = new AbortController().signal;
    await Promise.all([
      configChanges.fireAsync({ upsert: current, remove: [] }, signal),
      sourceChanges.fireAsync({ sourceId: 'workspace', upsert: current, remove: [] }, signal),
    ]);
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(firstChild.exitCode).not.toBeNull();
      expect(session.connectionManager.get('alpha')?.status).toBe('connected');
    });

    const statuses: string[] = [];
    const unsubscribe = session.connectionManager.onStatusChange((entry) => {
      if (entry.name === 'alpha') statuses.push(entry.status);
    });
    current = {};
    await Promise.all([
      configChanges.fireAsync({ upsert: {}, remove: ['alpha'] }, signal),
      sourceChanges.fireAsync({ sourceId: 'workspace', upsert: {}, remove: ['alpha'] }, signal),
    ]);
    await vi.waitFor(() => {
      expect(manager?.get('alpha')).toBeUndefined();
    });
    unsubscribe();

    expect(statuses).toContain('removed');
    expect(session.connectionManager.get('alpha')?.status).toBe('removed');
    expect(session.connectionManager.list().find((entry) => entry.name === 'alpha')?.status).toBe('removed');
  }, 20000);

  it('emits status changes when disclosure overrides change without respawning the process', async () => {
    const userManager = new McpConnectionManager({
      environmentResolver: environmentServices,
      environmentId: 'local',
      stdioCwd: () => cwd,
    });
    const userPool = new RefCountedMcpServerPool(userManager);
    let overrideEntries: Record<string, { deferred?: boolean; disabledTools?: string[] }> = {};
    const overrideChanges = new Emitter<void>();
    const workspaceManager = new McpConnectionManager();
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    const session = createSession([
      {
        id: 'user',
        priority: MCP_SOURCE_PRIORITY.user,
        ready: Promise.resolve(),
        view: userManager,
        entries: () => ({ tuned: { ...stdioServer(), deferred: true } }),
        acquire: (ownerId, servers) => userPool.acquire(ownerId, servers),
        release: (ownerId) => userPool.release(ownerId),
      },
      {
        id: 'workspace',
        priority: MCP_SOURCE_PRIORITY.workspace,
        ready: Promise.resolve(),
        view: workspaceManager,
        entries: () => overrideEntries,
        onDidChangeEntries: overrideChanges.event,
      },
    ]);
    await session.ready;
    expect(session.connectionManager.get('tuned')?.status).toBe('connected');
    expect(session.connectionManager.get('tuned')?.toolCount).toBe(4);
    expect(spawn).toHaveBeenCalledTimes(1);

    const seen: Array<{ status: string; toolCount: number; deferred: boolean }> = [];
    const unsubscribe = session.connectionManager.onStatusChange((entry) => {
      if (entry.name !== 'tuned') return;
      seen.push({
        status: entry.status,
        toolCount: entry.toolCount,
        deferred: session.connectionManager.deferredOf('tuned'),
      });
    });

    overrideEntries = { tuned: { disabledTools: ['echo'] } };
    overrideChanges.fire();
    await vi.waitFor(() => {
      expect(session.connectionManager.get('tuned')?.toolCount).toBe(3);
    });
    expect([...(session.connectionManager.resolved('tuned')?.enabledNames ?? [])].toSorted()).toEqual(['boom', 'read_env', 'whoami']);

    overrideEntries = { tuned: { disabledTools: ['boom'] } };
    overrideChanges.fire();
    await vi.waitFor(() => {
      expect([...(session.connectionManager.resolved('tuned')?.enabledNames ?? [])].toSorted()).toEqual(['echo', 'read_env', 'whoami']);
    });

    overrideEntries = { tuned: { deferred: false } };
    overrideChanges.fire();
    await vi.waitFor(() => {
      expect(seen.some((entry) => !entry.deferred)).toBe(true);
    });
    unsubscribe();

    expect(seen.map((entry) => entry.status)).toEqual(['connected', 'connected', 'connected']);
    expect(seen[0]).toMatchObject({ toolCount: 3, deferred: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    await userManager.shutdown();
    await workspaceManager.shutdown();
  }, 20000);
});

describe('SessionMcpService pre-connect arbitration', () => {
  let cwd: string;
  let disposables: DisposableStore;
  let sessions: SessionMcpService[];
  let managers: McpConnectionManager[];
  let oauthService: McpOAuthService;
  let environmentServices: IEnvironmentService;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-session-arb-cwd-'));
    disposables = new DisposableStore();
    sessions = [];
    managers = [];
    oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const environment = Object.assign(
      new FakeEnvironment({ environmentId: 'local', generation: 'test' }, { capabilities: ['process'] }),
      { process: new HostProcessService() },
    );
    environmentServices = {
      _serviceBrand: undefined,
      inspect: () => environment,
      acquire: () => ({ environment, track: <T,>(resource: T): T => resource, dispose: () => {} }),
      acquireWhenReady: async () => ({ environment, track: <T,>(resource: T): T => resource, dispose: () => {} }),
    } as unknown as IEnvironmentService;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sessions.map((session) => session.disposeAsync()));
    await Promise.all(managers.map((manager) => manager.shutdown()));
    await oauthService.dispose();
    disposables.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  function leasedSource(id: string, priority: number, entries: Record<string, McpServerConfig>): McpSource {
    const manager = new McpConnectionManager({
      environmentResolver: environmentServices,
      environmentId: 'local',
      stdioCwd: () => cwd,
      log: stubLog(),
    });
    managers.push(manager);
    const pool = new RefCountedMcpServerPool(manager);
    return {
      id,
      priority,
      ready: Promise.resolve(),
      view: manager,
      entries: () => entries,
      acquire: (ownerId, servers) => pool.acquire(ownerId, servers),
      release: (ownerId) => pool.release(ownerId),
    };
  }

  function openSession(sources: readonly McpSource[], ephemeral: Record<string, McpServerConfig> = {}): SessionMcpService {
    const sessionId = `arb-${sessions.length}`;
    const session = new SessionMcpService(
      makeSessionContext({ sessionId, workspaceId: 'ws', sessionDir: cwd, sessionScope: 'ws', cwd }),
      ephemeral,
      sources,
      [],
      { ready: Promise.resolve(), get: () => undefined } as unknown as IConfigService,
      oauthService,
      environmentServices,
      stubAgentIdentity(),
      stubLog(),
    );
    sessions.push(session);
    return session;
  }

  it('never spawns a shadowed lower-priority server and fails over when the winner source is disabled', async () => {
    const user = leasedSource('user', MCP_SOURCE_PRIORITY.user, { shared: stdioServer() });
    const workspace = leasedSource('workspace', MCP_SOURCE_PRIORITY.workspace, { shared: stdioServer() });
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

    const session = openSession([user, workspace]);
    await session.ready;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(user.view.get('shared')).toBeUndefined();
    expect(workspace.view.get('shared')?.status).toBe('connected');

    session.setSourceEnabled('workspace', false);
    await vi.waitFor(() => {
      expect(user.view.get('shared')?.status).toBe('connected');
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(workspace.view.get('shared')).toBeUndefined();
    expect(session.connectionManager.get('shared')?.status).toBe('connected');
  }, 20000);

  it('shares one child process across sessions of the same source until the last session releases it', async () => {
    const shared = leasedSource('workspace', MCP_SOURCE_PRIORITY.workspace, { shared: stdioServer() });
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');

    const first = openSession([shared]);
    const second = openSession([shared]);
    await Promise.all([first.ready, second.ready]);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [child] = await Promise.all(spawn.mock.results.map((result) => result.value));
    expect(child.exitCode).toBeNull();

    await first.disposeAsync();
    expect(child.exitCode).toBeNull();
    expect(second.connectionManager.get('shared')?.status).toBe('connected');

    await second.disposeAsync();
    await vi.waitFor(() => {
      expect(child.exitCode).not.toBeNull();
    });
    expect(shared.view.get('shared')).toBeUndefined();
  }, 20000);

  it('closes ephemeral caller processes immediately when the caller source is disabled', async () => {
    const shared = leasedSource('workspace', MCP_SOURCE_PRIORITY.workspace, {});
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    const session = openSession([shared], { eph: stdioServer() });
    await session.ready;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [child] = await Promise.all(spawn.mock.results.map((result) => result.value));
    expect(session.connectionManager.get('eph')?.status).toBe('connected');

    session.setSourceEnabled('caller', false);
    await vi.waitFor(() => {
      expect(child.exitCode).not.toBeNull();
    });
    expect(session.connectionManager.get('eph')?.status).toBe('removed');
    expect(spawn).toHaveBeenCalledTimes(1);
  }, 20000);

  it('fails over to a lower-priority source when a dynamic source registration is disposed', async () => {
    const workspace = leasedSource('workspace', MCP_SOURCE_PRIORITY.workspace, { shared: stdioServer() });
    const feature = leasedSource('feature', MCP_SOURCE_PRIORITY.workspace + 10, { shared: stdioServer() });
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    const session = openSession([workspace]);
    await session.ready;
    expect(spawn).toHaveBeenCalledTimes(1);

    const registration = session.registerSource(feature);
    await vi.waitFor(() => {
      expect(feature.view.get('shared')?.status).toBe('connected');
      expect(workspace.view.get('shared')).toBeUndefined();
    });
    expect(spawn).toHaveBeenCalledTimes(2);

    registration.dispose();
    await vi.waitFor(() => {
      expect(workspace.view.get('shared')?.status).toBe('connected');
      expect(feature.view.get('shared')).toBeUndefined();
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(session.connectionManager.get('shared')?.status).toBe('connected');
  }, 20000);
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
