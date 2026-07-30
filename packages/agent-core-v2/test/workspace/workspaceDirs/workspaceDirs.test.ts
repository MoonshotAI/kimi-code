/**
 * Scenario: workspace-level add-dir (the phase-3.5 behavior contract).
 *
 * Drives the REAL handler chain (WorkspaceLifecycleService →
 * WorkspaceHandlerService) with the real `WorkspaceDirsService`, the real
 * node-fs `FileProjectLocalConfigService`, the real fs watch service, and
 * the real Session-scope `workspaceContext` view, and proves:
 * - a persisted `addDir` writes `.kimi-code/local.toml` and refreshes every
 *   live session's view of the workspace;
 * - a second session of the same workspace sees the dir immediately;
 * - a handler rebuilt from scratch (simulated restart) keeps the persisted
 *   dir;
 * - `persist: false` stays in handler memory and never touches the disk;
 * - an external `local.toml` edit (another process) refreshes live session
 *   views through the fs watch.
 * Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceDirs/workspaceDirs.test.ts`.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
  type ISessionScopeHandle,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IEventService } from '#/app/event/event';
import {
  IProjectLocalConfigService,
} from '#/app/projectLocalConfig/projectLocalConfig';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
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
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { IWorkspaceHandlerService } from '#/workspace/workspaceHandler/workspaceHandler';
import { WorkspaceHandlerService } from '#/workspace/workspaceHandler/workspaceHandlerService';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';
import { WorkspaceToolPolicyService } from '#/workspace/workspaceToolPolicy/workspaceToolPolicyService';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';

import { stubLog } from '../../_base/log/stubs';

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

function workspaceSkillCatalogStub(): IWorkspaceSkillCatalog {
  const catalog = {
    getSkill: () => undefined,
    getPluginSkill: () => undefined,
    renderSkillPrompt: () => '',
    listSkills: () => [],
    listInvocableSkills: () => [],
    getSkillRoots: () => [],
    getSkippedByPolicy: () => [],
    getModelSkillListing: () => '',
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    catalog,
    onDidChange: Event.None,
    load: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    sessionData: () => ({
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      catalog,
      onDidChange: Event.None,
    }),
  } as unknown as IWorkspaceSkillCatalog;
}

function agentProfileLoaderStub(): IWorkspaceAgentProfileLoader {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

function userAgentProfileLoaderStub(): IUserAgentProfileLoader {
  return {
    ...agentProfileLoaderStub(),
    getDefaultProfile: () => {
      throw new Error('not implemented');
    },
  };
}

function workspaceInstructionsStub(): IWorkspaceInstructionsService {
  const provider = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    agentsMd: undefined,
    agentsMdWarning: undefined,
    onDidChange: Event.None,
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    snapshot: { agentsMd: undefined, agentsMdWarning: undefined },
    onDidChange: Event.None,
    reload: () => Promise.resolve(),
    sessionProvider: () => provider,
  } as unknown as IWorkspaceInstructionsService;
}

function workspaceMcpStub(): IWorkspaceMcpService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    sessionHandle: () => ({
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get connectionManager(): never {
        throw new Error('not implemented');
      },
    }),
  } as unknown as IWorkspaceMcpService;
}

describe('workspace add-dir (handler chain)', () => {
  let hosts: ScopedTestHost[];
  let tmpRoots: string[];

  beforeEach(() => {
    _clearScopedRegistryForTests();
    hosts = [];
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
      IWorkspaceDirs,
      WorkspaceDirsService,
      ScopeActivation.OnScopeCreated,
      'workspaceDirs',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionWorkspaceContext,
      SessionWorkspaceContextService,
      ScopeActivation.OnScopeCreated,
      'workspaceContext',
    );
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) {
      host.dispose();
    }
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tmpRoots.push(root);
    return root;
  }

  /** A project root with a `.git` marker so local.toml lands at the root. */
  async function makeProjectRoot(): Promise<string> {
    const root = await makeRoot('kimi-add-dir-proj-');
    await mkdir(join(root, '.git'));
    return root;
  }

  function buildHost(homeDir: string): ScopedTestHost {
    const bootstrap = {
      _serviceBrand: undefined,
      homeDir,
      osHomeDir: homeDir,
      scope: (name: string) => name,
    } as unknown as IBootstrapService;
    const hostFs = new HostFileSystem();
    const host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrap),
      stubPair(IHostEnvironment, {
        _serviceBrand: undefined,
        osKind: 'Linux',
        homeDir,
        ready: Promise.resolve(),
      } as unknown as IHostEnvironment),
      stubPair(IHostFileSystem, hostFs),
      stubPair(IHostFsWatchService, new HostFsWatchService()),
      stubPair(ILogService, stubLog()),
      stubPair(IConfigService, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: () => undefined,
        onDidSectionChange: () => ({ dispose: () => {} }),
      } as unknown as IConfigService),
      stubPair(ITelemetryService, noopTelemetryService),
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
      stubPair(
        IProjectLocalConfigService,
        new FileProjectLocalConfigService(bootstrap, hostFs),
      ),
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
      stubPair(IWorkspaceSkillCatalog, workspaceSkillCatalogStub()),
      stubPair(IWorkspaceAgentProfileLoader, agentProfileLoaderStub()),
      stubPair(IExtraAgentProfileLoader, agentProfileLoaderStub()),
      stubPair(IExplicitAgentProfileLoader, agentProfileLoaderStub()),
      stubPair(IUserAgentProfileLoader, userAgentProfileLoaderStub()),
      stubPair(IPluginAgentProfileLoader, agentProfileLoaderStub()),
      stubPair(IWorkspaceInstructionsService, workspaceInstructionsStub()),
      stubPair(IWorkspaceMcpService, workspaceMcpStub()),
    ]);
    hosts.push(host);
    return host;
  }

  async function handlerFor(
    host: ScopedTestHost,
    root: string,
  ): Promise<{ service: IWorkspaceHandlerService; dirs: IWorkspaceDirs }> {
    const handler = await host.app.accessor.get(IWorkspaceLifecycleService).handlerFor({ root });
    return {
      service: handler.accessor.get(IWorkspaceHandlerService),
      dirs: handler.accessor.get(IWorkspaceDirs),
    };
  }

  function dirsOf(handle: ISessionScopeHandle): readonly string[] {
    return handle.accessor.get(ISessionWorkspaceContext).additionalDirs;
  }

  it('persists addDir to local.toml and every session of the workspace sees the dir', async () => {
    const homeDir = await makeRoot('kimi-add-dir-home-');
    const root = await makeProjectRoot();
    const extra = await makeRoot('kimi-add-dir-extra-');
    const host = buildHost(homeDir);
    const { service, dirs } = await handlerFor(host, root);

    const s1 = await service.create({ sessionId: 's1', workDir: root });
    expect(dirsOf(s1)).toEqual([]);

    const result = await dirs.addDir({ path: extra, persist: true });

    expect(result.persisted).toBe(true);
    expect(result.projectRoot).toBe(root);
    expect(result.configPath).toBe(join(root, '.kimi-code', 'local.toml'));
    expect(result.additionalDirs).toEqual([extra]);
    // local.toml written on disk.
    const toml = await readFile(join(root, '.kimi-code', 'local.toml'), 'utf8');
    expect(toml).toContain('additional_dir');
    expect(toml).toContain(extra);
    // The live session's view refreshed through the change event.
    expect(dirsOf(s1)).toEqual([extra]);
    // A second session of the same workspace sees it immediately.
    const s2 = await service.create({ sessionId: 's2', workDir: root });
    expect(dirsOf(s2)).toEqual([extra]);
  });

  it('keeps the persisted dir across a handler rebuild (simulated restart)', async () => {
    const homeDir = await makeRoot('kimi-add-dir-home-');
    const root = await makeProjectRoot();
    const extra = await makeRoot('kimi-add-dir-extra-');
    const first = buildHost(homeDir);
    const firstHandler = await handlerFor(first, root);
    await firstHandler.service.create({ sessionId: 's1', workDir: root });
    await firstHandler.dirs.addDir({ path: extra, persist: true });
    first.dispose();
    hosts = hosts.filter((h) => h !== first);

    const second = buildHost(homeDir);
    const secondHandler = await handlerFor(second, root);
    const s2 = await secondHandler.service.create({ sessionId: 's2', workDir: root });
    expect(dirsOf(s2)).toEqual([extra]);
  });

  it('persist: false stays in handler memory, never touches the disk, and is shared', async () => {
    const homeDir = await makeRoot('kimi-add-dir-home-');
    const root = await makeProjectRoot();
    const extra = await makeRoot('kimi-add-dir-extra-');
    const host = buildHost(homeDir);
    const { service, dirs } = await handlerFor(host, root);
    const s1 = await service.create({ sessionId: 's1', workDir: root });

    const result = await dirs.addDir({ path: extra, persist: false });

    expect(result.persisted).toBe(false);
    expect(result.additionalDirs).toEqual([extra]);
    expect(dirsOf(s1)).toEqual([extra]);
    // Nothing written: local.toml does not exist.
    await expect(readFile(join(root, '.kimi-code', 'local.toml'), 'utf8')).rejects.toThrow();
    // The in-memory dir is shared with a second session of the workspace.
    const s2 = await service.create({ sessionId: 's2', workDir: root });
    expect(dirsOf(s2)).toEqual([extra]);
  });

  it('refreshes live session views when another process edits local.toml', async () => {
    const homeDir = await makeRoot('kimi-add-dir-home-');
    const root = await makeProjectRoot();
    const extra = await makeRoot('kimi-add-dir-extra-');
    const host = buildHost(homeDir);
    const { service } = await handlerFor(host, root);
    const s1 = await service.create({ sessionId: 's1', workDir: root });
    expect(dirsOf(s1)).toEqual([]);

    // External write (another process, an editor, `kimi` in a second CLI).
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    const writeLocalToml = () =>
      writeFile(join(root, '.kimi-code', 'local.toml'), `[workspace]\nadditional_dir = ["${extra}"]\n`);
    await writeLocalToml();

    // The chokidar watcher ignores files it finds during its initial scan
    // (`ignoreInitial`), so a write landing inside that window is swallowed;
    // rewrite while polling (slower than the 200ms reload debounce, so the
    // debounce always gets a quiet window) until a `modify` event lands.
    const deadline = Date.now() + 10_000;
    while (!dirsOf(s1).includes(extra)) {
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for watch-driven local.toml reload');
      }
      await writeLocalToml();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, 15_000);

  it('unions caller additionalDirs from create options into the shared set', async () => {
    const homeDir = await makeRoot('kimi-add-dir-home-');
    const root = await makeProjectRoot();
    const extra = await makeRoot('kimi-add-dir-extra-');
    const host = buildHost(homeDir);
    const { service } = await handlerFor(host, root);

    const s1 = await service.create({ sessionId: 's1', workDir: root, additionalDirs: [extra] });
    expect(dirsOf(s1)).toEqual([extra]);
    // Caller dirs join the handler-shared set: a session created WITHOUT the
    // option sees them too, and nothing was persisted.
    const s2 = await service.create({ sessionId: 's2', workDir: root });
    expect(dirsOf(s2)).toEqual([extra]);
    await expect(readFile(join(root, '.kimi-code', 'local.toml'), 'utf8')).rejects.toThrow();
  });
});
