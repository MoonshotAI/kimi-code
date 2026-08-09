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
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IEventService } from '#/app/event/event';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { IAppStateService } from '#/app/state/appState';
import { AppStateService } from '#/app/state/appStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { Error2, ErrorCodes } from '#/errors';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';
import { WorkspaceToolPolicyService } from '#/workspace/workspaceToolPolicy/workspaceToolPolicyService';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';
import { stubLog } from '../../_base/log/stubs';

import { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import { WorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycleService';
import {
  followWorkspaceHandlers,
  getLiveSessionById,
  resumeSessionById,
} from '#/app/workspaceLifecycle/sessionLookup';

function bootstrapStub(): IBootstrapService {
  return {
    homeDir: '/tmp',
    scope: (name: string) => name,
  } as unknown as IBootstrapService;
}

function hostEnvironmentStub(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  };
}

/** Catalog stub that mints `encodeWorkDirKey` ids and records createOrTouch calls. */
function catalogStub() {
  const workspaces = new Map<string, Workspace>();
  const createOrTouch = vi.fn((root: string, name?: string) => {
    const id = encodeWorkDirKey(root);
    const existing = workspaces.get(id);
    const workspace: Workspace =
      existing ?? { id, root, name: name ?? 'proj', createdAt: 1, lastOpenedAt: 1 };
    workspaces.set(id, workspace);
    return Promise.resolve(workspace);
  });
  const service: IWorkspaceService = {
    _serviceBrand: undefined,
    list: () => Promise.resolve([...workspaces.values()]),
    get: (id) => Promise.resolve(workspaces.get(id)),
    createOrTouch,
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
  return { service, createOrTouch };
}

function sessionIndexStub(): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: () => Promise.resolve({ state: 'ready', generation: 0, degradedCount: 0 }),
    status: () => ({ state: 'ready', generation: 0, degradedCount: 0 }),
    get: () => Promise.resolve(undefined),
    listRecent: () => Promise.resolve({ items: [] }),
    count: () => Promise.resolve(0),
    remove: () => Promise.resolve(),
  };
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

function sessionStubs(): ReturnType<typeof stubPair>[] {
  return [
    stubPair(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () => Promise.resolve({} as never),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent: () => Promise.resolve(),
    } satisfies ISessionMetadata),
    stubPair(ISessionToolPolicy, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      disabledTools: () => [],
      setDisabledTools: () => Promise.resolve(),
    } satisfies ISessionToolPolicy),
    stubPair(ISessionProcessRunner, {
      _serviceBrand: undefined,
      exec: () => Promise.reject(new Error('process exec is not supported in this test')),
    } satisfies ISessionProcessRunner),
    stubPair(IWorkspaceSkillCatalog, (() => {
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
      const onDidChange = () => ({ dispose: () => {} });
      return {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        catalog,
        onDidChange,
        load: () => Promise.resolve(),
        reload: () => Promise.resolve(),
        sessionData: () => ({
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          catalog,
          onDidChange,
        }),
      } as unknown as IWorkspaceSkillCatalog;
    })()),
    stubPair(IWorkspaceAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IExtraAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IExplicitAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IUserAgentProfileLoader, userAgentProfileLoaderStub()),
    stubPair(IPluginAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IWorkspaceInstructionsService, (() => {
      const onDidChange = () => ({ dispose: () => {} });
      return {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        snapshot: { agentsMd: undefined, agentsMdWarning: undefined },
        onDidChange,
        reload: () => Promise.resolve(),
        sessionProvider: () => ({
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          agentsMd: undefined,
          agentsMdWarning: undefined,
          onDidChange,
        }),
      } as unknown as IWorkspaceInstructionsService;
    })()),
    stubPair(IWorkspaceMcpService, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      connectionManager: () => {
        throw new Error('not implemented');
      },
      sessionHandle: () => ({
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get connectionManager(): McpConnectionManager {
          throw new Error('not implemented');
        },
      }),
    } as unknown as IWorkspaceMcpService),
    stubPair(IAgentLifecycleService, (() => {
      const main = {
        id: 'main',
        kind: LifecycleScope.Agent,
        accessor: {
          get: () => {
            throw new Error('unexpected main agent service access');
          },
        },
        dispose: () => {},
      } as const;
      return {
        _serviceBrand: undefined,
        onDidCreate: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        create: () => Promise.reject(new Error('not implemented')),
        fork: () => Promise.reject(new Error('not implemented')),
        get: (id: string) => (id === 'main' ? main : undefined),
        list: () => [],
        remove: () => Promise.resolve(),
        broadcastPermissionMode: () => {},
      } as unknown as IAgentLifecycleService;
    })()),
  ];
}

describe('WorkspaceLifecycleService', () => {
  let host: ScopedTestHost | undefined;
  let telemetryRecords: TelemetryRecord[];
  let createOrTouchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    telemetryRecords = [];
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceLifecycleService,
      WorkspaceLifecycleService,
      ScopeActivation.OnDemand,
      'workspaceLifecycle',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      ISessionLifecycleService,
      SessionLifecycleService,
      ScopeActivation.OnScopeCreated,
      'sessionLifecycle',
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
      LifecycleScope.App,
      IAppStateService,
      AppStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceStateService,
      WorkspaceStateService,
      ScopeActivation.OnScopeCreated,
      'state',
    );
    registerScopedService(
      LifecycleScope.App,
      IHostFileSystem,
      HostFileSystem,
      ScopeActivation.OnDemand,
      'hostFs',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function build(extra: ReturnType<typeof stubPair>[] = []): IWorkspaceLifecycleService {
    const catalog = catalogStub();
    createOrTouchSpy = catalog.createOrTouch;
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub()),
      stubPair(IHostEnvironment, hostEnvironmentStub()),
      stubPair(IWorkspaceService, catalog.service),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(IConfigService, { get: () => undefined } as unknown as IConfigService),
      stubPair(IAppendLogStore, {
        _serviceBrand: undefined,
        append: () => {},
        read: async function* () {},
        rewrite: () => Promise.resolve(),
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
        acquire: () => ({ dispose: () => {} }),
      } satisfies IAppendLogStore),
      stubPair(IAtomicDocumentStore, {
        _serviceBrand: undefined,
        get: () => Promise.resolve(undefined),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        list: () => Promise.resolve([]),
        watch: () => () => ({ dispose: () => {} }),
        acquire: () => ({ dispose: () => {} }),
      } as unknown as IAtomicDocumentStore),
      stubPair(IEventService, {
        _serviceBrand: undefined,
        onDidPublish: () => ({ dispose: () => {} }),
        publish: () => {},
        subscribe: () => ({ dispose: () => {} }),
      } satisfies IEventService),
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
        appendAdditionalDir: () => Promise.reject(new Error('not implemented')),
      } satisfies IProjectLocalConfigService),
      stubPair(IHostFsWatchService, {
        _serviceBrand: undefined,
        watch: () => ({ onDidChange: Event.None, dispose: () => {} }),
      } as unknown as IHostFsWatchService),
      stubPair(ILogService, stubLog()),
      stubPair(ITelemetryService, recordingTelemetry(telemetryRecords)),
      stubPair(ICronTaskPersistence, {
        _serviceBrand: undefined,
        get: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      } satisfies ICronTaskPersistence),
      ...sessionStubs(),
      ...extra,
    ]);
    return host.app.accessor.get(IWorkspaceLifecycleService);
  }

  it('handlerFor materializes a handler seeded with the workspace facts', async () => {
    const lifecycle = build();
    const handler = await lifecycle.handlerFor({ root: '/tmp/proj' });

    expect(handler.kind).toBe(LifecycleScope.Workspace);
    const ctx = handler.accessor.get(IWorkspaceContext);
    expect(ctx).toMatchObject({
      workspaceId: encodeWorkDirKey('/tmp/proj'),
      cwd: '/tmp/proj',
      source: 'local',
      persistenceScope: `sessions/${encodeWorkDirKey('/tmp/proj')}`,
      osBackendId: 'local',
      persistenceBackendId: 'local',
    });
    expect(lifecycle.handlers.list()).toEqual([handler]);
  });

  it('handlerFor joins concurrent materializations of the same workspace', async () => {
    const lifecycle = build();

    const [a, b] = await Promise.all([
      lifecycle.handlerFor({ root: '/tmp/proj' }),
      lifecycle.handlerFor({ root: '/tmp/proj' }),
    ]);

    expect(a).toBe(b);
    expect(lifecycle.handlers.list()).toHaveLength(1);
  });

  it('two concurrent sessions of one workspace share a single handler', async () => {
    const lifecycle = build();
    const workspaceId = encodeWorkDirKey('/tmp/proj');

    const [handlerA, handlerB] = await Promise.all([
      lifecycle.handlerFor({ root: '/tmp/proj' }),
      lifecycle.handlerFor({ workspaceId, root: '/tmp/proj' }),
    ]);
    expect(handlerA).toBe(handlerB);

    const sessions = handlerA.accessor.get(ISessionLifecycleService);
    const [s1, s2] = await Promise.all([
      sessions.create({ sessionId: 's1', workDir: '/tmp/proj' }),
      sessions.create({ sessionId: 's2', workDir: '/tmp/proj' }),
    ]);

    expect(s1.id).toBe('s1');
    expect(s2.id).toBe('s2');
    expect(lifecycle.handlers.list()).toEqual([handlerA]);
    expect(lifecycle.sessions.list(workspaceId).toSorted()).toEqual(['s1', 's2']);
  });

  it('handlerFor by workspaceId returns the live handler without re-touching the catalog', async () => {
    const lifecycle = build();
    const handler = await lifecycle.handlerFor({ root: '/tmp/proj' });
    expect(createOrTouchSpy).toHaveBeenCalledTimes(1);

    const again = await lifecycle.handlerFor({ workspaceId: encodeWorkDirKey('/tmp/proj') });

    expect(again).toBe(handler);
    // A live handler is returned as-is — no catalog write beyond the initial
    // materialization.
    expect(createOrTouchSpy).toHaveBeenCalledTimes(1);
  });

  it('handlerFor by unknown workspaceId without a root hint throws workspace.not_found', async () => {
    const lifecycle = build();

    await expect(lifecycle.handlerFor({ workspaceId: 'wd_missing' })).rejects.toMatchObject({
      code: ErrorCodes.WORKSPACE_NOT_FOUND,
    });
    expect(lifecycle.handlers.list()).toHaveLength(0);
  });

  it('a failed handler materialization does not disturb live handlers', async () => {
    const lifecycle = build();
    const first = await lifecycle.handlerFor({ root: '/tmp/proj' });

    const workspaces = host!.app.accessor.get(IWorkspaceService);
    const original = workspaces.createOrTouch.bind(workspaces);
    vi.spyOn(workspaces, 'createOrTouch').mockImplementation((root: string, name?: string) =>
      root === '/tmp/broken' ? Promise.reject(new Error('disk gone')) : original(root, name),
    );

    await expect(lifecycle.handlerFor({ root: '/tmp/broken' })).rejects.toThrow('disk gone');
    expect(lifecycle.handlers.list()).toEqual([first]);
    expect(first.accessor.get(IWorkspaceContext).workspaceId).toBe(encodeWorkDirKey('/tmp/proj'));
  });

  it('sessions.list is empty for a non-materialized workspace', () => {
    const lifecycle = build();
    expect(lifecycle.sessions.list('wd_missing')).toEqual([]);
  });

  describe('sessionLookup', () => {
    function indexWith(summary: {
      readonly id: string;
      readonly workspaceId: string;
      readonly cwd?: string;
    }): ReturnType<typeof stubPair> {
      return stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: (id: string) => Promise.resolve(id === summary.id ? { ...summary, createdAt: 1, updatedAt: 1, archived: false } : undefined),
      } as unknown as ISessionIndex);
    }

    it('resumeSessionById routes index → handlerFor → handler resume', async () => {
      const workspaceId = encodeWorkDirKey('/tmp/proj');
      const lifecycle = build([indexWith({ id: 's1', workspaceId, cwd: '/tmp/proj' })]);

      const handle = await resumeSessionById(host!.app.accessor, 's1');

      expect(handle?.id).toBe('s1');
      expect(lifecycle.handlers.list()).toHaveLength(1);
      expect(getLiveSessionById(host!.app.accessor, 's1')).toBe(handle);
    });

    it('resumeSessionById returns undefined for an unknown session', async () => {
      build();
      await expect(resumeSessionById(host!.app.accessor, 'nope')).resolves.toBeUndefined();
    });

    it('resumeSessionById reports session_load_failed when the index read fails', async () => {
      build([
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () =>
            Promise.reject(new Error2(ErrorCodes.SESSION_NOT_FOUND, 'index read failed')),
        } as unknown as ISessionIndex),
      ]);

      await expect(resumeSessionById(host!.app.accessor, 's1')).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
      expect(telemetryRecords).toContainEqual({
        event: 'session_load_failed',
        properties: { sessionId: 's1', reason: ErrorCodes.SESSION_NOT_FOUND },
      });
    });

    it('getLiveSessionById finds only live sessions', async () => {
      const lifecycle = build();
      const handler = await lifecycle.handlerFor({ root: '/tmp/proj' });
      const sessions = handler.accessor.get(ISessionLifecycleService);
      await sessions.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(getLiveSessionById(host!.app.accessor, 's1')?.id).toBe('s1');
      expect(getLiveSessionById(host!.app.accessor, 'other')).toBeUndefined();
    });

    it('followWorkspaceHandlers subscribes present and future handlers', async () => {
      const lifecycle = build();
      const closed: string[] = [];
      const sub = followWorkspaceHandlers(host!.app.accessor, (service) =>
        service.onDidCloseSession((event) => closed.push(event.sessionId)),
      );

      const first = await lifecycle.handlerFor({ root: '/tmp/proj' });
      await first.accessor.get(ISessionLifecycleService).create({ sessionId: 's1', workDir: '/tmp/proj' });
      // Materialized AFTER the follow subscription — still observed.
      const second = await lifecycle.handlerFor({ root: '/tmp/other' });
      await second.accessor.get(ISessionLifecycleService).create({ sessionId: 's2', workDir: '/tmp/other' });

      await first.accessor.get(ISessionLifecycleService).close('s1');
      await second.accessor.get(ISessionLifecycleService).close('s2');

      expect(closed.toSorted()).toEqual(['s1', 's2']);
      sub.dispose();
    });
  });
});
