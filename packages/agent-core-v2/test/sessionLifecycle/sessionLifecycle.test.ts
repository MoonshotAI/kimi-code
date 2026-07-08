import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IEventService } from '#/app/event/event';
import {
  type AgentTaskHooks,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycleService';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { createHooks } from '#/hooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceRegistry, type Workspace } from '#/app/workspaceRegistry/workspaceRegistry';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';

function bootstrapStub(): IBootstrapService {
  return {
    sessionsDir: '/tmp/sessions',
    homeDir: '/tmp',
    sessionScope: (workspaceId: string, sessionId: string) =>
      `sessions/${workspaceId}/${sessionId}`,
    sessionDir: (workspaceId: string, sessionId: string) =>
      `/tmp/sessions/${workspaceId}/${sessionId}`,
  } as IBootstrapService;
}

function metadataStub(): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: () => ({ dispose: () => {} }),
    read: () => Promise.resolve({} as never),
    update: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
    setArchived: () => Promise.resolve(),
    registerAgent: () => Promise.resolve(),
  };
}

function eventStub(): IEventService {
  return {
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => {} }),
    publish: () => {},
    subscribe: () => ({ dispose: () => {} }),
  };
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

function skillCatalogStub(): ISessionSkillCatalog {
  return {
    _serviceBrand: undefined,
    catalog: {
      getSkill: () => undefined,
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => '',
      listSkills: () => [],
      listInvocableSkills: () => [],
      getSkillRoots: () => [],
      getModelSkillListing: () => '',
    },
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    load: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

function workspaceRegistryStub(): IWorkspaceRegistry {
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    createOrTouch: (root, name) =>
      Promise.resolve<Workspace>({
        id: 'wd_stub',
        root,
        name: name ?? 'stub',
        createdAt: 0,
        lastOpenedAt: 0,
      }),
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
}

function persistentWorkspaceRegistryStub(): IWorkspaceRegistry {
  const workspaces = new Map<string, Workspace>();
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve([...workspaces.values()]),
    get: (id) => Promise.resolve(workspaces.get(id)),
    createOrTouch: (root, name) => {
      const id = encodeWorkDirKey(root);
      const now = 1;
      const existing = workspaces.get(id);
      const workspace: Workspace =
        existing !== undefined
          ? { ...existing, lastOpenedAt: now }
          : {
              id,
              root,
              name: name ?? 'proj',
              createdAt: now,
              lastOpenedAt: now,
            };
      workspaces.set(id, workspace);
      return Promise.resolve(workspace);
    },
    update: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(),
  };
}

function sessionIndexStub(): ISessionIndex {
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve({ items: [], total: 0, hasMore: false }),
    get: () => Promise.resolve(undefined),
    countActive: () => Promise.resolve(0),
  };
}

function sessionIndexWithSummary(
  sessionId: string,
  workDir: string,
  workspaceId = encodeWorkDirKey(workDir),
): ISessionIndex {
  const summary = {
    id: sessionId,
    workspaceId,
    cwd: workDir,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve({ items: [summary], total: 1, hasMore: false }),
    get: (id) => Promise.resolve(id === sessionId ? summary : undefined),
    countActive: () => Promise.resolve(1),
  };
}

function appendLogStoreStub(): IAppendLogStore {
  return {
    _serviceBrand: undefined,
    append: () => {},
    read: async function* () {},
    rewrite: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    acquire: () => ({ dispose: () => {} }),
  };
}

function atomicDocumentStoreStub(): IAtomicDocumentStore {
  return {
    _serviceBrand: undefined,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    watch: () => (_listener) => ({ dispose: () => {} }),
    acquire: () => ({ dispose: () => {} }),
  };
}

function agentLifecycleStub(): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>([
      'onWillStartAgentTask',
      'onDidStopAgentTask',
    ]),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidCreateMain: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    create: () => Promise.reject(new Error('not implemented')),
    notifyMainCreated: () => {},
    ensureMcpReady: () => Promise.resolve(),
    fork: () => Promise.reject(new Error('not implemented')),
    run: () => {
      throw new Error('not implemented');
    },
    getHandle: () => undefined,
    list: () => [],
    remove: () => Promise.resolve(),
  };
}

function agentLifecycleWithMainStub(): IAgentLifecycleService {
  const main = {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: {
      get: () => {
        throw new Error('unexpected main agent service access');
      },
    },
    dispose: () => {},
  } as IAgentScopeHandle;
  return {
    ...agentLifecycleStub(),
    getHandle: (id) => (id === MAIN_AGENT_ID ? main : undefined),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class NoopSessionExternalHooksService implements ISessionExternalHooksService {
  declare readonly _serviceBrand: undefined;
}

let recordedSessionHookEvents: string[] = [];

class RecordingSessionExternalHooksService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionLifecycleService lifecycle: ISessionLifecycleService) {
    super();
    this._register(
      lifecycle.hooks.onDidCreateSession.register('test', async (event, next) => {
        recordedSessionHookEvents.push(`create:${event.source}:${event.sessionId}`);
        await next();
      }),
    );
    this._register(
      lifecycle.hooks.onWillCloseSession.register('test', async (event, next) => {
        recordedSessionHookEvents.push(`close:${event.reason}:${event.sessionId}`);
        await next();
      }),
    );
  }
}

describe('SessionLifecycleService', () => {
  let host: ScopedTestHost | undefined;

  beforeEach(() => {
    recordedSessionHookEvents = [];
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionLifecycleService,
      SessionLifecycleService,
      InstantiationType.Delayed,
      'sessionLifecycle',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      NoopSessionExternalHooksService,
      InstantiationType.Eager,
      'externalHooks',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function build(extra: ReturnType<typeof stubPair>[] = []): ISessionLifecycleService {
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub()),
      stubPair(ISessionMetadata, metadataStub()),
      stubPair(IHostEnvironment, hostEnvironmentStub()),
      stubPair(ISessionSkillCatalog, skillCatalogStub()),
      stubPair(IWorkspaceRegistry, workspaceRegistryStub()),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(IAppendLogStore, appendLogStoreStub()),
      stubPair(IAtomicDocumentStore, atomicDocumentStoreStub()),
      stubPair(IEventService, eventStub()),
      stubPair(IAgentLifecycleService, agentLifecycleStub()),
      ...extra,
    ]);
    return host.app.accessor.get(ISessionLifecycleService);
  }

  it('create / get / list / close', async () => {
    const svc = build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(h.id).toBe('s1');
    expect(svc.get('s1')).toBe(h);
    expect(svc.list()).toEqual([h]);

    await svc.close('s1');
    expect(svc.get('s1')).toBeUndefined();
  });

  it('create seeds identity and materializes metadata', async () => {
    const svc = build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    // create() awaits ISessionMetadata.ready, so a resolved handle implies the
    // metadata service was resolved inside the new session scope.
    expect(h.kind).toBe(LifecycleScope.Session);
  });

  it('registers the workspace during create so a cold resume can resolve the workdir', async () => {
    const workDir = '/tmp/proj';
    const workspaceRegistry = persistentWorkspaceRegistryStub();
    const sessionIndex = sessionIndexWithSummary('s1', workDir);
    const first = build([
      stubPair(IWorkspaceRegistry, workspaceRegistry),
      stubPair(ISessionIndex, sessionIndex),
    ]);

    await first.create({ sessionId: 's1', workDir });
    await expect(workspaceRegistry.get(encodeWorkDirKey(workDir))).resolves.toMatchObject({
      root: workDir,
    });
    host?.dispose();
    host = undefined;

    const second = build([
      stubPair(IWorkspaceRegistry, workspaceRegistry),
      stubPair(ISessionIndex, sessionIndex),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    const resumed = await second.resume('s1');

    expect(resumed?.id).toBe('s1');
    expect(resumed?.accessor.get(ISessionContext).cwd).toBe(workDir);
  });

  it('resumes from the persisted cwd when the workspace registry entry is missing', async () => {
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(IWorkspaceRegistry, persistentWorkspaceRegistryStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume('s1');

    expect(resumed?.id).toBe('s1');
    expect(resumed?.accessor.get(ISessionContext).workspaceId).toBe(encodeWorkDirKey(workDir));
  });

  it('resumes with the persisted cwd and indexed workspace id when the registry root is stale', async () => {
    const workDir = '/tmp/proj';
    const staleRoot = '/tmp/stale';
    const indexedWorkspaceId = 'wd_indexed';
    const workspaceRegistry: IWorkspaceRegistry = {
      _serviceBrand: undefined,
      list: () => Promise.resolve([]),
      get: (id) =>
        Promise.resolve(
          id === indexedWorkspaceId
            ? {
                id: indexedWorkspaceId,
                root: staleRoot,
                name: 'stale',
                createdAt: 1,
                lastOpenedAt: 1,
              }
            : undefined,
        ),
      createOrTouch: (root, name) =>
        Promise.resolve({
          id: encodeWorkDirKey(root),
          root,
          name: name ?? 'proj',
          createdAt: 1,
          lastOpenedAt: 1,
        }),
      update: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
    };
    const svc = build([
      stubPair(IWorkspaceRegistry, workspaceRegistry),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir, indexedWorkspaceId)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume('s1');
    const ctx = resumed?.accessor.get(ISessionContext);

    expect(ctx?.cwd).toBe(workDir);
    expect(ctx?.workspaceId).toBe(indexedWorkspaceId);
    expect(ctx?.sessionDir).toBe(`/tmp/sessions/${indexedWorkspaceId}/s1`);
  });

  it('archive flags metadata, removes agents, publishes the event, and disposes the session', async () => {
    let archived: boolean | undefined;
    const removed: string[] = [];
    const published: { type: string; payload: unknown }[] = [];
    const agentHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: () => ({}) },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = build([
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          archived = value;
          return Promise.resolve();
        },
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        _serviceBrand: undefined,
        list: () => [agentHandle],
        remove: (id: string) => {
          removed.push(id);
          return Promise.resolve();
        },
      } as unknown as IAgentLifecycleService),
      stubPair(IEventService, {
        ...eventStub(),
        publish: (event: { type: string; payload: unknown }) => published.push(event),
      }),
    ]);

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.archive('s1');

    expect(archived).toBe(true);
    expect(removed).toEqual(['main']);
    expect(published).toEqual([
      { type: 'event.session.archived', payload: { sessionId: 's1' } },
    ]);
    expect(svc.get('s1')).toBeUndefined();
  });

  it('fires onDidCreateSession with the new handle', async () => {
    const svc = build();
    let captured: { readonly sessionId: string } | undefined;
    svc.onDidCreateSession((e) => {
      captured = e;
    });
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(captured).toMatchObject({ sessionId: 's1', handle: h, source: 'startup' });
  });

  it('runs constructor-registered session lifecycle hooks before returning create and close', async () => {
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      RecordingSessionExternalHooksService,
      InstantiationType.Eager,
      'externalHooks',
    );
    const svc = build();

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.close('s1');

    expect(recordedSessionHookEvents).toEqual(['create:startup:s1', 'close:exit:s1']);
  });

  it('waits for MCP initialization before create returns', async () => {
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        ensureMcpReady: () => mcpReady,
      }),
    ]);

    let settled = false;
    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' }).then(() => {
      settled = true;
    });

    await tick();
    expect(settled).toBe(false);

    resolveMcpReady?.();
    await create;
    expect(settled).toBe(true);
  });

  it('fires onDidCloseSession when a session is closed', async () => {
    const svc = build();
    const closed: string[] = [];
    svc.onDidCloseSession((e) => closed.push(e.sessionId));
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.close('s1');
    expect(closed).toEqual(['s1']);
  });

  it('fires onDidArchiveSession when a session is archived', async () => {
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        _serviceBrand: undefined,
        list: () => [],
        remove: () => Promise.resolve(),
      } as unknown as IAgentLifecycleService),
    ]);
    const archived: string[] = [];
    svc.onDidArchiveSession((e) => archived.push(e.sessionId));
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.archive('s1');
    expect(archived).toEqual(['s1']);
  });
});
