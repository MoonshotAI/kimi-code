import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isAbsolute, resolve } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IEventService } from '#/app/event/event';
import {
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { IAgentPlanService } from '#/agent/plan/plan';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycleService';
import { ISessionActivityKernel } from '#/activity/activity';
import { SessionActivityKernel } from '#/activity/sessionActivityKernel';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { createHooks } from '#/hooks';
import { ISessionActivity } from '#/session/sessionActivity/sessionActivity';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceLocalConfigService } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import { IWorkspaceRegistry, type Workspace } from '#/app/workspaceRegistry/workspaceRegistry';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { stubSessionActivityKernel } from '../../activity/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

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
      getSkippedByPolicy: () => [],
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

function workspaceLocalConfigStub(
  localDirs: readonly string[] = [],
): IWorkspaceLocalConfigService {
  return {
    _serviceBrand: undefined,
    readAdditionalDirs: (workDir: string) =>
      Promise.resolve({
        projectRoot: workDir,
        configPath: `${workDir}/.kimi-code/local.toml`,
        additionalDirs: [...localDirs],
      }),
    resolveAdditionalDirs: (baseDir: string, dirs: readonly string[]) =>
      Promise.resolve(dirs.map((d) => (isAbsolute(d) ? resolve(d) : resolve(baseDir, d)))),
    appendAdditionalDir: () => Promise.reject(new Error('not implemented')),
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
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidCreateMain: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    create: () => Promise.reject(new Error('not implemented')),
    notifyMainCreated: () => {},
    notifyAgentTaskStopped: () => {},
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

function configStub(values: Record<string, unknown> = {}): IConfigService {
  return {
    get: (domain: string) => values[domain],
    getAll: () => ({ ...values }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: () => ({ dispose: () => {} }),
  } as unknown as IConfigService;
}

function agentLifecycleCapturingPlanSpy(opts: { mainPreexists?: boolean } = {}): {
  lifecycle: IAgentLifecycleService;
  enter: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const enter = vi.fn(() => Promise.resolve());
  const planService = {
    enter,
    cancel: vi.fn(),
    clear: vi.fn(() => Promise.resolve()),
    exit: vi.fn(),
    status: vi.fn(() => Promise.resolve(null)),
  };
  const makeMain = (agentId: string): IAgentScopeHandle =>
    ({
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (token: unknown) => (token === IAgentPlanService ? planService : {}),
      },
      dispose: () => {},
    }) as IAgentScopeHandle;
  let mainHandle: IAgentScopeHandle | undefined = opts.mainPreexists
    ? makeMain(MAIN_AGENT_ID)
    : undefined;
  const create = vi.fn((args: { agentId: string }) => {
    mainHandle = makeMain(args.agentId);
    return Promise.resolve(mainHandle);
  });
  const lifecycle: IAgentLifecycleService = {
    ...agentLifecycleStub(),
    getHandle: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
    create,
  };
  return { lifecycle, enter, create };
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
  let telemetryRecords: TelemetryRecord[];

  beforeEach(() => {
    recordedSessionHookEvents = [];
    telemetryRecords = [];
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
    registerScopedService(
      LifecycleScope.Session,
      ISessionActivityKernel,
      SessionActivityKernel,
      InstantiationType.Delayed,
      'activity',
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
      stubPair(IConfigService, configStub()),
      stubPair(ISessionCronService, { _serviceBrand: undefined } as unknown as ISessionCronService),
      stubPair(ISessionActivityKernel, stubSessionActivityKernel()),
      stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub()),
      stubPair(ITelemetryService, recordingTelemetry(telemetryRecords)),
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

  it('create appends the session to the shared session_index.jsonl', async () => {
    const appended: unknown[] = [];
    const svc = build([
      stubPair(IAppendLogStore, {
        ...appendLogStoreStub(),
        append: (scope: string, key: string, record: unknown) => {
          appended.push({ scope, key, record });
        },
      }),
    ]);

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    const workspaceId = encodeWorkDirKey('/tmp/proj');
    expect(appended).toEqual([
      {
        scope: '',
        key: 'session_index.jsonl',
        record: {
          sessionId: 's1',
          sessionDir: `/tmp/sessions/${workspaceId}/s1`,
          workDir: '/tmp/proj',
        },
      },
    ]);
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

  it('restore clears the archived flag when the session exists on disk', async () => {
    let archived: boolean | undefined;
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          archived = value;
          return Promise.resolve();
        },
      }),
    ]);

    const restored = await svc.restore('s1');

    expect(restored?.id).toBe('s1');
    expect(archived).toBe(false);
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

  it('emits session_started with resumed: false on create', async () => {
    const svc = build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { resumed: false },
    });
  });

  it('emits session_started with resumed: true on resume', async () => {
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(IWorkspaceRegistry, persistentWorkspaceRegistryStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    await svc.resume('s1');

    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { resumed: true },
    });
  });

  it('emits session_load_failed with the error code when resume fails, then rethrows', async () => {
    const svc = build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new Error2(ErrorCodes.SESSION_NOT_FOUND, 'index read failed')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { reason: ErrorCodes.SESSION_NOT_FOUND },
    });
  });

  it('emits session_load_failed with the error name for plain errors', async () => {
    const svc = build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new TypeError('bad index')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toBeInstanceOf(TypeError);
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { reason: 'TypeError' },
    });
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

  it('hides a session from get/list until its resume finishes', async () => {
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleWithMainStub(),
        ensureMcpReady: () => mcpReady,
      }),
    ]);

    const resumed = svc.resume('s1');
    await tick();

    // materialize has registered the handle in `sessions` and is now blocked on
    // ensureMcpReady with `resuming` set — the handle must not be observable yet.
    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);

    resolveMcpReady?.();
    const handle = await resumed;

    expect(handle?.id).toBe('s1');
    expect(svc.get('s1')).toBe(handle);
    expect(svc.list()).toEqual([handle]);
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

  // Mirrors v1's runtime.test.ts additional-dirs coverage: session
  // creation/resume must merge `.kimi-code/local.toml` dirs with caller
  // additionalDirs into the session workspace context.
  describe('additional dirs', () => {
    beforeEach(() => {
      registerScopedService(
        LifecycleScope.Session,
        ISessionWorkspaceContext,
        SessionWorkspaceContextService,
        InstantiationType.Delayed,
        'workspaceContext',
      );
    });

    function dirsOf(handle: { accessor: { get<T>(id: unknown): T } }): readonly string[] {
      return (handle.accessor.get(ISessionWorkspaceContext) as ISessionWorkspaceContext)
        .additionalDirs;
    }

    it('loads project-local additional dirs into the session workspace on create', async () => {
      const svc = build([
        stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub(['/tmp/extra'])),
      ]);
      const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
      expect(dirsOf(h)).toEqual(['/tmp/extra']);
    });

    it('merges caller additionalDirs and resolves relative paths against workDir', async () => {
      const svc = build();
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['../sibling', '/abs/dir'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/sibling', '/abs/dir']);
    });

    it('deduplicates project-local and caller dirs after resolving', async () => {
      const svc = build([
        stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub(['/tmp/shared'])),
      ]);
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['../shared', '/tmp/other'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/shared', '/tmp/other']);
    });

    it('supports multiple project-local and caller additionalDirs', async () => {
      const svc = build([
        stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub(['/tmp/a', '/tmp/b'])),
      ]);
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['/tmp/c', '/tmp/d'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/a', '/tmp/b', '/tmp/c', '/tmp/d']);
    });

    it('loads project-local dirs when resuming a closed session', async () => {
      const mainHandle = {
        id: MAIN_AGENT_ID,
        kind: LifecycleScope.Agent,
        accessor: { get: () => ({}) },
        dispose: () => {},
      } as unknown as IAgentScopeHandle;
      const summary = { id: 's1', workspaceId: 'wd_stub' } as SessionSummary;
      const svc = build([
        stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub(['/tmp/extra'])),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
        stubPair(IWorkspaceRegistry, {
          ...workspaceRegistryStub(),
          get: () =>
            Promise.resolve({
              id: 'wd_stub',
              root: '/tmp/proj',
              name: 'stub',
              createdAt: 0,
              lastOpenedAt: 0,
            }),
        }),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          getHandle: () => mainHandle,
        }),
      ]);

      const h = await svc.resume('s1');

      expect(h).toBeDefined();
      expect(dirsOf(h!)).toEqual(['/tmp/extra']);
    });

    it('fork inherits project-local dirs', async () => {
      const svc = build([
        stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub(['/tmp/extra'])),
        stubPair(ISessionActivity, {
          _serviceBrand: undefined,
          status: () => 'idle' as const,
          isIdle: () => true,
        }),
        stubPair(IWorkspaceRegistry, {
          ...workspaceRegistryStub(),
          get: () =>
            Promise.resolve({
              id: 'wd_stub',
              root: '/tmp/proj',
              name: 'stub',
              createdAt: 0,
              lastOpenedAt: 0,
            }),
        }),
      ]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(dirsOf(target)).toEqual(['/tmp/extra']);
    });

    it('create mints a session_-prefixed lowercase id when none is supplied', async () => {
      const svc = build();
      const h = await svc.create({ workDir: '/tmp/proj' });

      expect(h.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(h.id).toBe(h.id.toLowerCase());
      expect(svc.get(h.id)).toBe(h);
    });

    it('fork mints a session_-prefixed lowercase id when newSessionId is omitted', async () => {
      const svc = build([
        stubPair(ISessionActivity, {
          _serviceBrand: undefined,
          status: () => 'idle' as const,
          isIdle: () => true,
        }),
        stubPair(IWorkspaceRegistry, {
          ...workspaceRegistryStub(),
          get: () =>
            Promise.resolve({
              id: 'wd_stub',
              root: '/tmp/proj',
              name: 'stub',
              createdAt: 0,
              lastOpenedAt: 0,
            }),
        }),
      ]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const target = await svc.fork({ sourceSessionId: 'src' });

      expect(target.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(target.id).toBe(target.id.toLowerCase());
      expect(target.id).not.toBe('src');
    });
  });

  describe('defaultPlanMode bootstrap', () => {
    it('enters plan mode on a fresh session when config.defaultPlanMode is true', async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(create).toHaveBeenCalledTimes(1);
      expect(enter).toHaveBeenCalledTimes(1);
    });

    it('leaves plan mode inactive when config.defaultPlanMode is absent', async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = build([
        stubPair(IConfigService, configStub({})),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });

    it('does not apply config.defaultPlanMode when resuming a session', async () => {
      const workDir = '/tmp/proj';
      const summary = { id: 's1', workspaceId: 'wd_stub', cwd: workDir } as SessionSummary;
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy({
        mainPreexists: true,
      });
      const svc = build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
        stubPair(IWorkspaceRegistry, persistentWorkspaceRegistryStub()),
      ]);

      await svc.resume('s1');

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });
  });
});
