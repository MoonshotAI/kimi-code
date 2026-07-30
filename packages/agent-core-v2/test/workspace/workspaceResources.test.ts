/**
 * Scenario: workspace resource sharing across concurrent sessions (the
 * phase-3 behavior contract).
 *
 * Drives the REAL handler chain (WorkspaceLifecycleService →
 * WorkspaceHandlerService) with the real Workspace-scope resource services
 * and proves: one shared MCP connection manager (and one initial connect)
 * for two sessions of the same workspace, no skill rescan when the second
 * session lists skills, and the fs-watch fan-out refreshing a live session's
 * skill list after `.agents/skills` changes on disk. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceResources.test.ts`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { BuiltinAgentProfileLoaderService } from '#/app/agentProfileCatalog/builtinAgentProfileLoaderService';
import { IAgentCatalogRuntimeOptions } from '#/workspace/workspaceAgentProfileLoader/agentCatalogRuntimeOptions';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { UserAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoaderService';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { PluginAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoaderService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IEventService } from '#/app/event/event';
import { IPluginService } from '#/app/plugin/plugin';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import { InMemorySkillDiscovery } from '#/app/skillCatalog/inMemorySkillDiscovery';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { BuiltinSkillSource, IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { IUserFileSkillSource, UserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';
import { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import { WorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycleService';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import '#/session/agentLifecycle/profile/profiles';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { SessionSkillCatalogService } from '#/session/sessionSkillCatalog/skillCatalogService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { IWorkspaceHandlerService } from '#/workspace/workspaceHandler/workspaceHandler';
import { WorkspaceHandlerService } from '#/workspace/workspaceHandler/workspaceHandlerService';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';
import { WorkspaceToolPolicyService } from '#/workspace/workspaceToolPolicy/workspaceToolPolicyService';
import { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { WorkspaceAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoaderService';
import { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { ExtraAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoaderService';
import { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { ExplicitAgentProfileLoaderService } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoaderService';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { WorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructionsService';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { WorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcpService';
import { IMcpOAuthStore, McpOAuthStoreAdapter } from '#/app/mcpConfig/oauthStore';
import { IWorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { WorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { WorkspaceSkillCatalogService } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalogService';
import { ExplicitFileSkillSource, IExplicitFileSkillSource } from '#/workspace/workspaceSkillCatalog/explicitFileSkillSource';
import { ExtraFileSkillSource, IExtraFileSkillSource } from '#/workspace/workspaceSkillCatalog/extraFileSkillSource';
import { IPluginSkillSource, PluginSkillSource } from '#/workspace/workspaceSkillCatalog/pluginSkillSource';
import { IWorkspaceRootSkillSource, WorkspaceRootSkillSource } from '#/workspace/workspaceSkillCatalog/rootFileSkillSource';

import { stubLog } from '../_base/log/stubs';
import { stubSkill } from '../app/skillCatalog/stubs';
import { stdioFixture } from '../mcpCore/stubs';

function workspaceCatalogStub(): IWorkspaceService {
  const workspaces = new Map<string, Workspace>();
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve([...workspaces.values()]),
    get: (id) => Promise.resolve(workspaces.get(id)),
    createOrTouch: (root, name) => {
      const id = encodeWorkDirKey(root);
      const workspace: Workspace = workspaces.get(id) ?? {
        id,
        root,
        name: name ?? 'proj',
        createdAt: 1,
        lastOpenedAt: 1,
      };
      workspaces.set(id, workspace);
      return Promise.resolve(workspace);
    },
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
}

function pluginStub(): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: Event.None,
    enabledMcpServers: async () => ({}),
    pluginSkillRoots: async () => [],
    pluginAgentRoots: async () => [],
  } as unknown as IPluginService;
}

class TrustedWorkspaceTrustStub implements IWorkspaceTrust {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  readonly onDidChange = Event.None as IWorkspaceTrust['onDidChange'];
  isTrusted(): boolean {
    return true;
  }
  get(): Promise<boolean> {
    return Promise.resolve(true);
  }
  trust(): Promise<void> {
    return Promise.resolve();
  }
  untrust(): Promise<void> {
    return Promise.resolve();
  }
}

describe('workspace resource sharing (handler chain)', () => {
  let host: ScopedTestHost | undefined;
  let tmpRoots: string[];

  beforeEach(() => {
    _clearScopedRegistryForTests();
    tmpRoots = [];
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceLifecycleService,
      WorkspaceLifecycleService,
      ScopeActivation.OnScopeCreated,
      'workspaceLifecycle',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceHandlerService,
      WorkspaceHandlerService,
      ScopeActivation.OnScopeCreated,
      'workspaceHandler',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceToolPolicy,
      WorkspaceToolPolicyService,
      ScopeActivation.OnScopeCreated,
      'workspaceToolPolicy',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceSkillCatalog,
      WorkspaceSkillCatalogService,
      ScopeActivation.OnScopeCreated,
      'workspaceSkillCatalog',
    );
    registerScopedService(LifecycleScope.Workspace, IExplicitFileSkillSource, ExplicitFileSkillSource, ScopeActivation.OnScopeCreated, 'workspaceSkillCatalog');
    registerScopedService(LifecycleScope.Workspace, IExtraFileSkillSource, ExtraFileSkillSource, ScopeActivation.OnScopeCreated, 'workspaceSkillCatalog');
    registerScopedService(LifecycleScope.Workspace, IWorkspaceRootSkillSource, WorkspaceRootSkillSource, ScopeActivation.OnScopeCreated, 'workspaceSkillCatalog');
    registerScopedService(LifecycleScope.Workspace, IPluginSkillSource, PluginSkillSource, ScopeActivation.OnScopeCreated, 'workspaceSkillCatalog');
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceAgentProfileLoader,
      WorkspaceAgentProfileLoaderService,
      ScopeActivation.OnScopeCreated,
      'workspaceAgentProfileLoader',
    );
    registerScopedService(LifecycleScope.Workspace, IExtraAgentProfileLoader, ExtraAgentProfileLoaderService, ScopeActivation.OnScopeCreated, 'workspaceAgentProfileLoader');
    registerScopedService(LifecycleScope.Workspace, IExplicitAgentProfileLoader, ExplicitAgentProfileLoaderService, ScopeActivation.OnScopeCreated, 'workspaceAgentProfileLoader');
    registerScopedService(LifecycleScope.Workspace, IUserAgentProfileLoader, UserAgentProfileLoaderService, ScopeActivation.OnScopeCreated, 'workspaceAgentProfileLoader');
    registerScopedService(LifecycleScope.Workspace, IPluginAgentProfileLoader, PluginAgentProfileLoaderService, ScopeActivation.OnScopeCreated, 'workspaceAgentProfileLoader');
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceInstructionsService,
      WorkspaceInstructionsService,
      ScopeActivation.OnScopeCreated,
      'workspaceInstructions',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceMcpService,
      WorkspaceMcpService,
      ScopeActivation.OnScopeCreated,
      'workspaceMcp',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceMcpConfigService,
      WorkspaceMcpConfigService,
      ScopeActivation.OnScopeCreated,
      'workspaceMcpConfig',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceTrust,
      TrustedWorkspaceTrustStub,
      ScopeActivation.OnDemand,
      'workspaceTrust',
    );
    registerScopedService(
      LifecycleScope.App,
      IMcpOAuthStore,
      McpOAuthStoreAdapter,
      ScopeActivation.OnDemand,
      'mcpConfig',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceDirs,
      WorkspaceDirsService,
      ScopeActivation.OnScopeCreated,
      'workspaceDirs',
    );
    registerScopedService(LifecycleScope.Session, ISessionSkillCatalog, SessionSkillCatalogService, ScopeActivation.OnScopeCreated, 'sessionSkillCatalog');
    registerScopedService(LifecycleScope.Session, ISessionStateService, SessionStateService, ScopeActivation.OnScopeCreated, 'state');
    registerScopedService(LifecycleScope.App, IBuiltinSkillSource, BuiltinSkillSource, ScopeActivation.OnDemand, 'skillCatalog');
    registerScopedService(LifecycleScope.App, IUserFileSkillSource, UserFileSkillSource, ScopeActivation.OnDemand, 'skillCatalog');
    registerScopedService(LifecycleScope.App, IAgentProfileRegistry, AgentProfileRegistryService, ScopeActivation.OnDemand, 'agentProfileCatalog');
    registerScopedService(LifecycleScope.App, IBuiltinAgentProfileLoader, BuiltinAgentProfileLoaderService, ScopeActivation.OnDemand, 'agentProfileCatalog');
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tmpRoots.push(root);
    return root;
  }

  function buildHost(discovery: ISkillDiscovery, homeDir: string): void {
    host = createScopedTestHost([
      stubPair(IBootstrapService, {
        _serviceBrand: undefined,
        homeDir,
        osHomeDir: homeDir,
        scope: (name: string) => name,
      } as unknown as IBootstrapService),
      stubPair(IHostEnvironment, {
        _serviceBrand: undefined,
        osKind: 'Linux',
        homeDir,
        ready: Promise.resolve(),
      } as unknown as IHostEnvironment),
      stubPair(IHostFileSystem, new HostFileSystem()),
      stubPair(IHostFsWatchService, new HostFsWatchService()),
      stubPair(ILogService, stubLog()),
      stubPair(IConfigService, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: () => undefined,
        onDidSectionChange: () => ({ dispose: () => {} }),
      } as unknown as IConfigService),
      stubPair(ITelemetryService, noopTelemetryService),
      stubPair(ISkillDiscovery, discovery),
      stubPair(ISkillCatalogRuntimeOptions, {
        _serviceBrand: undefined,
      } as unknown as ISkillCatalogRuntimeOptions),
      stubPair(IAgentCatalogRuntimeOptions, {
        _serviceBrand: undefined,
      } as unknown as IAgentCatalogRuntimeOptions),
      stubPair(IPluginService, pluginStub()),
      stubPair(IWorkspaceService, workspaceCatalogStub()),
      stubPair(ISessionIndex, {
        _serviceBrand: undefined,
        list: () => Promise.resolve({ items: [], total: 0, hasMore: false }),
        get: () => Promise.resolve(undefined),
        countActive: () => Promise.resolve(0),
      } as unknown as ISessionIndex),
      stubPair(IAppendLogStore, {
        _serviceBrand: undefined,
        append: () => {},
        read: async function* () {},
        rewrite: () => Promise.resolve(),
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
        acquire: () => ({ dispose: () => {} }),
      } as unknown as IAppendLogStore),
      stubPair(IAtomicDocumentStore, {
        _serviceBrand: undefined,
        get: () => Promise.resolve(undefined),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        list: () => Promise.resolve([]),
        watch: () => Event.None,
        acquire: () => ({ dispose: () => {} }),
      } as unknown as IAtomicDocumentStore),
      stubPair(IEventService, {
        _serviceBrand: undefined,
        publish: () => {},
        subscribe: () => ({ dispose: () => {} }),
      } as unknown as IEventService),
      stubPair(ICronTaskPersistence, {
        _serviceBrand: undefined,
        list: () => Promise.resolve([]),
      } as unknown as ICronTaskPersistence),
      stubPair(IProjectLocalConfigService, {
        _serviceBrand: undefined,
        readAdditionalDirs: (workDir: string) =>
          Promise.resolve({
            projectRoot: workDir,
            configPath: `${workDir}/.kimi-code/local.toml`,
            additionalDirs: [],
          }),
        resolveAdditionalDirs: (_base: string, dirs: readonly string[]) =>
          Promise.resolve([...dirs]),
      } as unknown as IProjectLocalConfigService),
      stubPair(ISessionMetadata, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        onDidChangeMetadata: () => ({ dispose: () => {} }),
        read: () => Promise.resolve({} as never),
        update: () => Promise.resolve(),
        setTitle: () => Promise.resolve(),
        setArchived: () => Promise.resolve(),
        registerAgent: () => Promise.resolve(),
      } as unknown as ISessionMetadata),
      stubPair(ISessionToolPolicy, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        onDidChange: () => ({ dispose: () => {} }),
        disabledTools: () => [],
        setDisabledTools: () => Promise.resolve(),
      } as unknown as ISessionToolPolicy),
      stubPair(ISessionProcessRunner, {
        _serviceBrand: undefined,
        exec: () => Promise.reject(new Error('process exec is not supported in this test')),
      } satisfies ISessionProcessRunner),
      stubPair(IAgentLifecycleService, {
        _serviceBrand: undefined,
        onDidCreate: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        create: () => Promise.reject(new Error('not implemented')),
        fork: () => Promise.reject(new Error('not implemented')),
        get: () => undefined,
        list: () => [],
        remove: () => Promise.resolve(),
        broadcastPermissionMode: () => {},
      } as unknown as IAgentLifecycleService),
    ]);
  }

  async function handlerFor(root: string): Promise<IWorkspaceHandlerService> {
    const handler = await (host as ScopedTestHost).app.accessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root });
    return handler.accessor.get(IWorkspaceHandlerService);
  }

  it('runs one shared MCP manager and one initial connect for two concurrent sessions', async () => {
    const root = await makeRoot('kimi-ws-mcp-');
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      join(root, '.kimi-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          alpha: { transport: 'stdio', command: process.execPath, args: [stdioFixture] },
        },
      }),
      'utf8',
    );
    const home = await makeRoot('kimi-ws-mcp-home-');
    buildHost(new InMemorySkillDiscovery(), home);
    const connectAll = vi.spyOn(McpConnectionManager.prototype, 'connectAll');

    const svc = await handlerFor(root);
    const [s1, s2] = await Promise.all([
      svc.create({ sessionId: 's1', workDir: root }),
      svc.create({ sessionId: 's2', workDir: root }),
    ]);

    const m1 = s1.accessor.get(ISessionMcpHandle);
    const m2 = s2.accessor.get(ISessionMcpHandle);
    expect(m1.connectionManager).toBe(m2.connectionManager);
    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(m1.connectionManager.get('alpha')?.status).toBe('connected');
  }, 20000);

  it('does not rescan skills when a second session of the workspace lists them', async () => {
    const root = await makeRoot('kimi-ws-skill-');
    await mkdir(join(root, '.kimi-code', 'skills'), { recursive: true });
    const home = await makeRoot('kimi-ws-skill-home-');
    const counting = new InMemorySkillDiscovery();
    counting.setProjectSkills([stubSkill('project-skill')]);
    let discoverCalls = 0;
    const discovery: ISkillDiscovery = {
      _serviceBrand: undefined,
      discover: async (roots) => {
        discoverCalls += 1;
        return counting.discover(roots);
      },
    };
    buildHost(discovery, home);

    const svc = await handlerFor(root);
    const s1 = await svc.create({ sessionId: 's1', workDir: root });
    const c1 = s1.accessor.get(ISessionSkillCatalog);
    await c1.ready;
    expect(c1.catalog.getSkill('project-skill')).toBeDefined();
    const callsAfterFirst = discoverCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const s2 = await svc.create({ sessionId: 's2', workDir: root });
    const c2 = s2.accessor.get(ISessionSkillCatalog);
    await c2.ready;
    expect(c2.catalog.getSkill('project-skill')).toBeDefined();
    expect(discoverCalls).toBe(callsAfterFirst);
  }, 20000);

  it('refreshes a live session skill list when .agents/skills changes on disk', async () => {
    const root = await makeRoot('kimi-ws-watch-');
    const home = await makeRoot('kimi-ws-watch-home-');
    buildHost(new FileSkillDiscovery(stubLog()), home);

    const svc = await handlerFor(root);
    const s1 = await svc.create({ sessionId: 's1', workDir: root });
    const catalog = s1.accessor.get(ISessionSkillCatalog);
    await catalog.ready;
    expect(catalog.catalog.getSkill('watched-skill')).toBeUndefined();

    await mkdir(join(root, '.agents', 'skills', 'watched-skill'), { recursive: true });
    await writeFile(
      join(root, '.agents', 'skills', 'watched-skill', 'SKILL.md'),
      '---\nname: watched-skill\ndescription: from watch\n---\nbody',
      'utf8',
    );

    await vi.waitFor(
      () => {
        expect(catalog.catalog.getSkill('watched-skill')?.description).toBe('from watch');
      },
      // Real FSEvents delivery + the 200 ms source debounce + a real disk
      // rescan: under high parallel load the 10 s budget flakes, so allow 30 s.
      { timeout: 30000, interval: 100 },
    );
  }, 60000);
});
