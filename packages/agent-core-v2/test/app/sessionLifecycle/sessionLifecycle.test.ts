/**
 * `sessionLifecycle` domain (L6) — App-to-Session scope lifecycle scenarios.
 *
 * Covers public create, resume, close, archive, fork, and failed-initialization
 * recovery contracts through the real scoped host. Persistence, host, config,
 * and agent boundaries are controlled through their service interfaces.
 *
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/sessionLifecycle/sessionLifecycle.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  type ScopeSeed,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IEventService } from '#/app/event/event';
import {
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { IAgentPlanService } from '#/agent/plan/plan';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
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
import { FileSessionIndex } from '#/app/sessionIndex/sessionIndexService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWorkspaceLocalConfigService } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import { IWorkspaceRegistry, type Workspace } from '#/app/workspaceRegistry/workspaceRegistry';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { stubLog } from '../../_base/log/stubs';
import { stubSessionActivityKernel } from '../../activity/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubFlag } from '../flag/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';

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

function tmpBootstrapStub(root: string): IBootstrapService {
  return {
    sessionsDir: join(root, 'sessions'),
    homeDir: root,
    scope: (name: string) => name,
    sessionScope: (workspaceId: string, sessionId: string) =>
      `sessions/${workspaceId}/${sessionId}`,
    sessionDir: (workspaceId: string, sessionId: string) =>
      join(root, 'sessions', workspaceId, sessionId),
    agentHomedir: (workspaceId: string, sessionId: string, agentId: string) =>
      join(root, 'sessions', workspaceId, sessionId, 'agents', agentId),
  } as IBootstrapService;
}

function cronStoreStub(
  initial: readonly CronTask[] = [],
): ICronTaskPersistence & { readonly docs: Map<string, CronTask> } {
  const docs = new Map(initial.map((task) => [task.id, task]));
  return {
    _serviceBrand: undefined,
    docs,
    get: (_workspaceId, taskId) => Promise.resolve(docs.get(taskId)),
    list: () => Promise.resolve([...docs.values()]),
    save: (_workspaceId, task) => {
      docs.set(task.id, task);
      return Promise.resolve();
    },
    delete: (_workspaceId, taskId) => {
      docs.delete(taskId);
      return Promise.resolve();
    },
  };
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
    whenReady: () => Promise.resolve(undefined),
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
    whenReady: (id) => Promise.resolve(id === MAIN_AGENT_ID ? main : undefined),
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
    whenReady: (id: string) => Promise.resolve(id === MAIN_AGENT_ID ? mainHandle : undefined),
    create,
  };
  return { lifecycle, enter, create };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  let tmpRoots: string[];

  beforeEach(() => {
    recordedSessionHookEvents = [];
    telemetryRecords = [];
    tmpRoots = [];
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
    // The unit under test copies session files through hostFs on fork; the
    // real backend has no dependencies and operates on the tmp paths the
    // fork tests seed, so register it instead of stubbing.
    registerScopedService(
      LifecycleScope.App,
      IHostFileSystem,
      HostFileSystem,
      InstantiationType.Delayed,
      'hostFs',
    );
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  function build(extra: ScopeSeed = []): ISessionLifecycleService {
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
      stubPair(ICronTaskPersistence, cronStoreStub()),
      ...extra,
    ]);
    return host.app.accessor.get(ISessionLifecycleService);
  }

  async function makeTmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-fork-test-'));
    tmpRoots.push(root);
    return root;
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

  it('publishes a created handle to read APIs before the create hook completes', async () => {
    const svc = build();
    let resumed: Awaited<ReturnType<ISessionLifecycleService['resume']>>;
    let fetched: ReturnType<ISessionLifecycleService['get']>;
    let listed: ReturnType<ISessionLifecycleService['list']> = [];
    const hook = svc.hooks.onDidCreateSession.register('read-live-session', async (event, next) => {
      resumed = await svc.resume(event.sessionId);
      fetched = svc.get(event.sessionId);
      listed = svc.list();
      await next();
    });

    const created = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    expect(resumed!).toBe(created);
    expect(fetched!).toBe(created);
    expect(listed).toEqual([created]);
    hook.dispose();
  });

  it('rejects create when its creation hook closes the published session', async () => {
    const svc = build();
    const closed: string[] = [];
    svc.onDidCloseSession((event) => closed.push(event.sessionId));
    const hook = svc.hooks.onDidCreateSession.register(
      'close-created-session',
      async (event, next) => {
        await svc.close(event.sessionId);
        await next();
      },
    );

    await expect(
      svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_CLOSED });

    expect(closed).toEqual(['s1']);
    expect(svc.get('s1')).toBeUndefined();
    hook.dispose();
  });

  it('does not share a disposed handle with a second resume during the creation hook', async () => {
    const hookStarted = deferred();
    const finishHook = deferred();
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    const hook = svc.hooks.onDidCreateSession.register(
      'hold-created-session',
      async (_event, next) => {
        hookStarted.resolve();
        await finishHook.promise;
        await next();
      },
    );

    const firstResume = svc.resume('s1');
    const firstRejected = expect(firstResume).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    await hookStarted.promise;
    await svc.close('s1');
    const secondResume = svc.resume('s1');
    finishHook.resolve();

    await expect(secondResume).resolves.toBeUndefined();
    await firstRejected;
    expect(svc.get('s1')).toBeUndefined();
    hook.dispose();
  });

  it('hides a session while close waits for its lifecycle hook', async () => {
    const createHookStarted = deferred();
    const finishCreateHook = deferred();
    const closeHookStarted = deferred();
    const finishCloseHook = deferred();
    const svc = build();
    const createHook = svc.hooks.onDidCreateSession.register(
      'hold-created-session',
      async (_event, next) => {
        createHookStarted.resolve();
        await finishCreateHook.promise;
        await next();
      },
    );
    const closeHook = svc.hooks.onWillCloseSession.register(
      'hold-closing-session',
      async (_event, next) => {
        closeHookStarted.resolve();
        await finishCloseHook.promise;
        await next();
      },
    );
    const closed: string[] = [];
    svc.onDidCloseSession((event) => closed.push(event.sessionId));

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const createRejected = expect(create).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    await createHookStarted.promise;
    const close = svc.close('s1');
    await closeHookStarted.promise;
    finishCreateHook.resolve();
    await createRejected;

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);
    await expect(svc.resume('s1')).resolves.toBeUndefined();
    expect(closed).toEqual([]);

    finishCloseHook.resolve();
    await close;
    expect(closed).toEqual(['s1']);
    createHook.dispose();
    closeHook.dispose();
  });

  it('does not expose an initializing session after its close hook fails', async () => {
    const createHookStarted = deferred();
    const finishCreateHook = deferred();
    const failure = new Error('close hook failed');
    const svc = build();
    const createHook = svc.hooks.onDidCreateSession.register(
      'hold-created-session',
      async (_event, next) => {
        createHookStarted.resolve();
        await finishCreateHook.promise;
        await next();
      },
    );
    const closeHook = svc.hooks.onWillCloseSession.register('fail-close', () => {
      throw failure;
    });

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const createRejected = expect(create).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    await createHookStarted.promise;
    await expect(svc.close('s1')).rejects.toBe(failure);

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);
    await expect(svc.resume('s1')).resolves.toBeUndefined();

    finishCreateHook.resolve();
    await createRejected;
    expect(svc.get('s1')).toBeUndefined();
    createHook.dispose();
    closeHook.dispose();
  });

  it('ignores close while archive owns initialization shutdown', async () => {
    const createHookStarted = deferred();
    const finishCreateHook = deferred();
    const archiveStarted = deferred();
    const finishArchive = deferred();
    const archivedValues: boolean[] = [];
    const svc = build([
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value) => {
          archivedValues.push(value);
          archiveStarted.resolve();
          return finishArchive.promise;
        },
      }),
    ]);
    const createHook = svc.hooks.onDidCreateSession.register(
      'hold-created-session',
      async (_event, next) => {
        createHookStarted.resolve();
        await finishCreateHook.promise;
        await next();
      },
    );
    const closed: string[] = [];
    const archived: string[] = [];
    svc.onDidCloseSession((event) => closed.push(event.sessionId));
    svc.onDidArchiveSession((event) => archived.push(event.sessionId));

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const createRejected = expect(create).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    await createHookStarted.promise;
    const archive = svc.archive('s1');
    await archiveStarted.promise;
    await svc.close('s1');
    finishCreateHook.resolve();
    await createRejected;

    expect(archivedValues).toEqual([true]);
    expect(closed).toEqual([]);

    finishArchive.resolve();
    await archive;
    expect(archived).toEqual(['s1']);
    createHook.dispose();
  });

  it('keeps an initializing create private until it is published', async () => {
    const mcpStarted = deferred();
    const mcpReady = deferred();
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        ensureMcpReady: () => {
          mcpStarted.resolve();
          return mcpReady.promise;
        },
      }),
    ]);

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await mcpStarted.promise;
    const resume = svc.resume('s1');

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);

    mcpReady.resolve();
    const resumed = await resume;
    const created = await create;
    expect(resumed).toBe(created);
    expect(svc.get('s1')).toBe(created);
    expect(svc.list()).toEqual([created]);
  });

  it('retries resume lookup after an initializing create rolls back', async () => {
    const mcpStarted = deferred();
    const mcpReady = deferred();
    const failure = new Error('MCP initialization failed');
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        ensureMcpReady: () => {
          mcpStarted.resolve();
          return mcpReady.promise;
        },
      }),
    ]);

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await mcpStarted.promise;
    const rejected = expect(create).rejects.toBe(failure);
    const resume = svc.resume('s1');

    mcpReady.reject(failure);
    await rejected;
    await expect(resume).resolves.toBeUndefined();
    expect(svc.get('s1')).toBeUndefined();
  });

  it('honors close after an in-flight session reaches publication', async () => {
    const firstMcpStarted = deferred();
    const firstMcp = deferred();
    let attempts = 0;
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        ensureMcpReady: () => {
          attempts += 1;
          if (attempts === 1) {
            firstMcpStarted.resolve();
            return firstMcp.promise;
          }
          return Promise.resolve();
        },
      }),
    ]);
    const closed: string[] = [];
    svc.onDidCloseSession((event) => closed.push(event.sessionId));

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await firstMcpStarted.promise;
    const close = svc.close('s1');
    const rejected = expect(create).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    firstMcp.resolve();
    await rejected;
    await close;
    expect(closed).toEqual(['s1']);
    const retried = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(svc.get('s1')).toBe(retried);
  });

  it('honors close requested while workspace registration blocks handle creation', async () => {
    const workspaceStarted = deferred();
    const workspaceReady = deferred<Workspace>();
    const registry = workspaceRegistryStub();
    const svc = build([
      stubPair(IWorkspaceRegistry, {
        ...registry,
        createOrTouch: () => {
          workspaceStarted.resolve();
          return workspaceReady.promise;
        },
      }),
    ]);
    const closed: string[] = [];
    svc.onDidCloseSession((event) => closed.push(event.sessionId));

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await workspaceStarted.promise;
    const close = svc.close('s1');
    const rejected = expect(create).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    expect(closed).toEqual([]);
    expect(svc.get('s1')).toBeUndefined();
    workspaceReady.resolve({
      id: 'wd_stub',
      root: '/tmp/proj',
      name: 'stub',
      createdAt: 0,
      lastOpenedAt: 0,
    });

    await close;
    await rejected;
    expect(closed).toEqual(['s1']);
    expect(svc.get('s1')).toBeUndefined();
  });

  it('honors archive requested while the host environment blocks handle creation', async () => {
    const localConfigRead = deferred();
    const hostReady = deferred();
    const archivedValues: boolean[] = [];
    const localConfig = workspaceLocalConfigStub();
    const svc = build([
      stubPair(IHostEnvironment, { ...hostEnvironmentStub(), ready: hostReady.promise }),
      stubPair(IWorkspaceLocalConfigService, {
        ...localConfig,
        resolveAdditionalDirs: (baseDir, dirs) => {
          localConfigRead.resolve();
          return localConfig.resolveAdditionalDirs(baseDir, dirs);
        },
      }),
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value) => {
          archivedValues.push(value);
          return Promise.resolve();
        },
      }),
    ]);
    const archived: string[] = [];
    svc.onDidArchiveSession((event) => archived.push(event.sessionId));

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await localConfigRead.promise;
    const archive = svc.archive('s1');
    const rejected = expect(create).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });
    hostReady.resolve();

    await archive;
    await rejected;
    expect(archivedValues).toEqual([true]);
    expect(archived).toEqual(['s1']);
    expect(svc.get('s1')).toBeUndefined();
  });

  it('settles a pre-handle close when session initialization fails', async () => {
    const workspaceStarted = deferred();
    const workspaceReady = deferred<Workspace>();
    const failure = new Error('workspace registration failed');
    const registry = workspaceRegistryStub();
    const svc = build([
      stubPair(IWorkspaceRegistry, {
        ...registry,
        createOrTouch: () => {
          workspaceStarted.resolve();
          return workspaceReady.promise;
        },
      }),
    ]);

    const create = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await workspaceStarted.promise;
    const close = svc.close('s1');
    const rejected = expect(create).rejects.toBe(failure);
    workspaceReady.reject(failure);

    await rejected;
    await expect(close).resolves.toBeUndefined();
    expect(svc.get('s1')).toBeUndefined();
  });

  it('allows only one same-id create initialization until failed cleanup releases the id', async () => {
    const firstMcpStarted = deferred();
    const firstMcp = deferred();
    const failure = new Error('MCP initialization failed');
    let attempts = 0;
    let workspaceTouches = 0;
    const workspaceRegistry = workspaceRegistryStub();
    const svc = build([
      stubPair(IWorkspaceRegistry, {
        ...workspaceRegistry,
        createOrTouch: (root, name) => {
          workspaceTouches += 1;
          return workspaceRegistry.createOrTouch(root, name);
        },
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        ensureMcpReady: () => {
          attempts += 1;
          if (attempts === 1) {
            firstMcpStarted.resolve();
            return firstMcp.promise;
          }
          return Promise.resolve();
        },
      }),
    ]);

    const firstCreate = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await firstMcpStarted.promise;
    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toMatchObject({
      code: ErrorCodes.SESSION_ALREADY_EXISTS,
    });
    expect(attempts).toBe(1);
    expect(workspaceTouches).toBe(1);
    const rejected = expect(firstCreate).rejects.toBe(failure);
    firstMcp.reject(failure);
    await rejected;

    expect(svc.get('s1')).toBeUndefined();

    const retried = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(svc.get('s1')).toBe(retried);
    expect(attempts).toBe(2);
    expect(workspaceTouches).toBe(2);
  });

  it('allows a same-id resume retry after its creation hook fails', async () => {
    const failure = new Error('session creation hook failed');
    let attempts = 0;
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    const hook = svc.hooks.onDidCreateSession.register('fail-once', async (_event, next) => {
      attempts += 1;
      if (attempts === 1) throw failure;
      await next();
    });

    await expect(svc.resume('s1')).rejects.toBe(failure);
    expect(svc.get('s1')).toBeUndefined();

    const retried = await svc.resume('s1');
    expect(svc.get('s1')).toBe(retried);
    hook.dispose();
  });

  it('allows a same-id create retry when failed-session agent cleanup rejects', async () => {
    const flushStarted = deferred();
    const flush = deferred();
    const initializationFailure = new Error('session index flush failed');
    const removed: string[] = [];
    let flushAttempts = 0;
    const agentHandle = (id: string) =>
      ({
        id,
        kind: LifecycleScope.Agent,
        accessor: { get: () => ({}) },
        dispose: () => {},
      }) as unknown as IAgentScopeHandle;
    const svc = build([
      stubPair(IAppendLogStore, {
        ...appendLogStoreStub(),
        flush: () => {
          flushAttempts += 1;
          if (flushAttempts === 1) {
            flushStarted.resolve();
            return flush.promise;
          }
          return Promise.resolve();
        },
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [agentHandle('main'), agentHandle('subagent')],
        remove: (id: string) => {
          removed.push(id);
          return id === 'main'
            ? Promise.reject(new Error('agent removal failed'))
            : Promise.resolve();
        },
      }),
    ]);

    const creation = svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await flushStarted.promise;
    const rejected = expect(creation).rejects.toBe(initializationFailure);
    flush.reject(initializationFailure);
    await rejected;

    expect(removed).toHaveLength(2);
    expect(removed).toEqual(expect.arrayContaining(['main', 'subagent']));
    expect(svc.get('s1')).toBeUndefined();

    const retried = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(svc.get('s1')).toBe(retried);
  });

  it('hides a session from get/list until its resume finishes', async () => {
    const mcpStarted = deferred();
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleWithMainStub(),
        ensureMcpReady: () => {
          mcpStarted.resolve();
          return mcpReady;
        },
      }),
    ]);

    const resumed = svc.resume('s1');
    await mcpStarted.promise;

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

  describe('fork session state', () => {
    function workspaceGetStub(): ReturnType<typeof stubPair> {
      return stubPair(IWorkspaceRegistry, {
        ...workspaceRegistryStub(),
        get: () =>
          Promise.resolve({
            id: 'wd_stub',
            root: '/tmp/proj',
            name: 'stub',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
      });
    }

    it('waits for a creating source to publish before forking it', async () => {
      const mcpStarted = deferred();
      const mcpReady = deferred();
      let mcpAttempts = 0;
      const indexGet = vi.fn(() => Promise.resolve(undefined));
      const svc = build([
        workspaceGetStub(),
        stubPair(ISessionIndex, { ...sessionIndexStub(), get: indexGet }),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          ensureMcpReady: () => {
            mcpAttempts += 1;
            if (mcpAttempts === 1) {
              mcpStarted.resolve();
              return mcpReady.promise;
            }
            return Promise.resolve();
          },
        }),
      ]);

      const creating = svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await mcpStarted.promise;
      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(indexGet).not.toHaveBeenCalled();
      mcpReady.resolve();
      const source = await creating;
      const target = await forked;

      expect(svc.get('src')).toBe(source);
      expect(target.id).toBe('dst');
    });

    it('waits for a resuming source to publish before forking it', async () => {
      const mcpStarted = deferred();
      const mcpReady = deferred();
      let mcpAttempts = 0;
      const sourceIndex = sessionIndexWithSummary('src', '/tmp/proj', 'wd_stub');
      const indexGet = vi.fn(sourceIndex.get.bind(sourceIndex));
      const svc = build([
        workspaceGetStub(),
        stubPair(ISessionIndex, { ...sourceIndex, get: indexGet }),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleWithMainStub(),
          ensureMcpReady: () => {
            mcpAttempts += 1;
            if (mcpAttempts === 1) {
              mcpStarted.resolve();
              return mcpReady.promise;
            }
            return Promise.resolve();
          },
        }),
      ]);

      const resuming = svc.resume('src');
      await mcpStarted.promise;
      const indexCallsBeforeFork = indexGet.mock.calls.length;
      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(indexGet).toHaveBeenCalledTimes(indexCallsBeforeFork);
      mcpReady.resolve();
      const source = await resuming;
      const target = await forked;

      expect(svc.get('src')).toBe(source);
      expect(target.id).toBe('dst');
    });

    it('does not fork a source whose initialization fails', async () => {
      const mcpStarted = deferred();
      const mcpReady = deferred();
      const failure = new Error('source MCP initialization failed');
      const indexGet = vi.fn(() => Promise.resolve(undefined));
      const svc = build([
        workspaceGetStub(),
        stubPair(ISessionIndex, { ...sessionIndexStub(), get: indexGet }),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          ensureMcpReady: () => {
            mcpStarted.resolve();
            return mcpReady.promise;
          },
        }),
      ]);

      const creating = svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await mcpStarted.promise;
      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
      const createRejected = expect(creating).rejects.toBe(failure);
      const forkRejected = expect(forked).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });

      expect(indexGet).not.toHaveBeenCalled();
      mcpReady.reject(failure);
      await createRejected;
      await forkRejected;

      expect(svc.get('src')).toBeUndefined();
      expect(svc.get('dst')).toBeUndefined();
      expect(svc.list()).toEqual([]);
    });

    it('waits for source close to settle before using the persisted fallback', async () => {
      const createHookStarted = deferred();
      const finishCreateHook = deferred();
      const closeHookStarted = deferred();
      const finishCloseHook = deferred();
      const sourceIndex = sessionIndexWithSummary('src', '/tmp/proj', 'wd_stub');
      const indexGet = vi.fn(sourceIndex.get.bind(sourceIndex));
      const svc = build([
        workspaceGetStub(),
        stubPair(ISessionIndex, { ...sourceIndex, get: indexGet }),
      ]);
      const createHook = svc.hooks.onDidCreateSession.register(
        'hold-created-source',
        async (event, next) => {
          if (event.sessionId === 'src') {
            createHookStarted.resolve();
            await finishCreateHook.promise;
          }
          await next();
        },
      );
      const closeHook = svc.hooks.onWillCloseSession.register(
        'hold-closing-source',
        async (event, next) => {
          if (event.sessionId === 'src') {
            closeHookStarted.resolve();
            await finishCloseHook.promise;
          }
          await next();
        },
      );

      const creating = svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const createRejected = expect(creating).rejects.toMatchObject({
        code: ErrorCodes.SESSION_CLOSED,
      });
      await createHookStarted.promise;
      const closing = svc.close('src');
      await closeHookStarted.promise;
      const indexCallsBeforeFork = indexGet.mock.calls.length;
      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(indexGet).toHaveBeenCalledTimes(indexCallsBeforeFork);
      finishCreateHook.resolve();
      await createRejected;
      expect(indexGet).toHaveBeenCalledTimes(indexCallsBeforeFork);

      finishCloseHook.resolve();
      await closing;
      const target = await forked;

      expect(target.id).toBe('dst');
      expect(svc.get('src')).toBeUndefined();
      createHook.dispose();
      closeHook.dispose();
    });

    it('copies blobs, plans, background tasks, and media originals into the fork', async () => {
      const root = await makeTmpRoot();
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      const srcDir = join(root, 'sessions', 'wd_stub', 'src');
      await mkdir(join(srcDir, 'agents', 'main', 'blobs'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'main', 'blobs', 'ab12cd'), 'blob-bytes');
      await mkdir(join(srcDir, 'agents', 'main', 'plans'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'main', 'plans', 'p1.md'), '# plan');
      await mkdir(join(srcDir, 'agents', 'main', 'tasks', 'bash-1'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'main', 'tasks', 'bash-1.json'), '{}');
      await writeFile(join(srcDir, 'agents', 'main', 'tasks', 'bash-1', 'output.log'), 'out');
      await mkdir(join(srcDir, 'media-originals'), { recursive: true });
      await writeFile(join(srcDir, 'media-originals', 'x.png'), 'png');
      // Excluded from the copy: state.json (rewritten with fork provenance),
      // the wire logs (copied with a fork boundary record), and the source's
      // debug log.
      await writeFile(join(srcDir, 'state.json'), '{"source":true}');
      await writeFile(join(srcDir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');
      await mkdir(join(srcDir, 'logs'), { recursive: true });
      await writeFile(join(srcDir, 'logs', 'kimi-code.log'), 'log');

      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      const dstDir = join(root, 'sessions', 'wd_stub', 'dst');
      await expect(
        readFile(join(dstDir, 'agents', 'main', 'blobs', 'ab12cd'), 'utf8'),
      ).resolves.toBe('blob-bytes');
      await expect(
        readFile(join(dstDir, 'agents', 'main', 'plans', 'p1.md'), 'utf8'),
      ).resolves.toBe('# plan');
      await expect(
        readFile(join(dstDir, 'agents', 'main', 'tasks', 'bash-1.json'), 'utf8'),
      ).resolves.toBe('{}');
      await expect(
        readFile(join(dstDir, 'agents', 'main', 'tasks', 'bash-1', 'output.log'), 'utf8'),
      ).resolves.toBe('out');
      await expect(readFile(join(dstDir, 'media-originals', 'x.png'), 'utf8')).resolves.toBe(
        'png',
      );
      // The materialize path is stubbed to write nothing, so any of these in
      // the target could only have come from the copy.
      await expect(stat(join(dstDir, 'state.json'))).rejects.toThrow();
      await expect(stat(join(dstDir, 'agents', 'main', 'wire.jsonl'))).rejects.toThrow();
      await expect(stat(join(dstDir, 'logs'))).rejects.toThrow();
    });

    it('rolls back the target session when fork fails after materializing', async () => {
      const root = await makeTmpRoot();
      const srcDir = join(root, 'sessions', 'wd_stub', 'src');
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(ISessionMetadata, {
          ...metadataStub(),
          read: () =>
            Promise.resolve({
              agents: { main: { homedir: join(srcDir, 'agents', 'main') } },
            } as never),
        }),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      // Seed one file so the copy materializes the target dir before the
      // (stubbed) agent creation rejects.
      await mkdir(join(srcDir, 'agents', 'main', 'plans'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'main', 'plans', 'p1.md'), '# plan');
      const dstDir = join(root, 'sessions', 'wd_stub', 'dst');

      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );

      expect(svc.get('dst')).toBeUndefined();
      await expect(stat(dstDir)).rejects.toThrow();
      // The registry rollback unblocks a retry with the same ids: it fails
      // again at agent creation, not with SESSION_ALREADY_EXISTS.
      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );
    });

    it('removes a fork target when materialization fails after metadata is persisted', async () => {
      const root = await makeTmpRoot();
      const bootstrap = tmpBootstrapStub(root);
      const storage = new FileStorageService(root);
      const queryStore = stubQueryStore();
      const flags = stubFlag(false);
      const log = stubLog();
      const targetMcpStarted = deferred();
      const targetMcp = deferred();
      const failure = new Error('target MCP initialization failed');
      let mcpAttempts = 0;
      registerScopedService(
        LifecycleScope.Session,
        ISessionMetadata,
        SessionMetadata,
        InstantiationType.Delayed,
        'sessionMetadata',
      );
      const svc = build([
        stubPair(IBootstrapService, bootstrap),
        workspaceGetStub(),
        stubPair(IFileSystemStorageService, storage),
        [IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore)],
        stubPair(IQueryStore, queryStore),
        stubPair(IFlagService, flags),
        stubPair(ILogService, log),
        [ISessionIndex, new SyncDescriptor(FileSessionIndex)],
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          ensureMcpReady: () => {
            mcpAttempts += 1;
            if (mcpAttempts === 2) {
              targetMcpStarted.resolve();
              return targetMcp.promise;
            }
            return Promise.resolve();
          },
        }),
      ]);
      const index = host!.app.accessor.get(ISessionIndex);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
      await targetMcpStarted.promise;
      await expect(index.get('dst')).resolves.toMatchObject({ id: 'dst' });
      const rejected = expect(forked).rejects.toBe(failure);
      targetMcp.reject(failure);
      await rejected;

      await expect(stat(join(root, 'sessions', 'wd_stub', 'dst'))).rejects.toThrow();
      await expect(index.get('dst')).resolves.toBeUndefined();

      const retried = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
      expect(retried.id).toBe('dst');
    });

    it('keeps a published fork resumable when close waits during initialization', async () => {
      const root = await makeTmpRoot();
      const bootstrap = tmpBootstrapStub(root);
      const storage = new FileStorageService(root);
      const targetMcpStarted = deferred();
      const targetMcp = deferred();
      let mcpAttempts = 0;
      registerScopedService(
        LifecycleScope.Session,
        ISessionMetadata,
        SessionMetadata,
        InstantiationType.Delayed,
        'sessionMetadata',
      );
      const svc = build([
        stubPair(IBootstrapService, bootstrap),
        workspaceGetStub(),
        stubPair(IFileSystemStorageService, storage),
        [IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore)],
        stubPair(IQueryStore, stubQueryStore()),
        stubPair(IFlagService, stubFlag(false)),
        stubPair(ILogService, stubLog()),
        [ISessionIndex, new SyncDescriptor(FileSessionIndex)],
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleWithMainStub(),
          ensureMcpReady: () => {
            mcpAttempts += 1;
            if (mcpAttempts === 2) {
              targetMcpStarted.resolve();
              return targetMcp.promise;
            }
            return Promise.resolve();
          },
        }),
      ]);
      const index = host!.app.accessor.get(ISessionIndex);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
      await targetMcpStarted.promise;
      const close = svc.close('dst');
      const forkRejected = expect(forked).rejects.toMatchObject({
        code: ErrorCodes.SESSION_CLOSED,
      });
      targetMcp.resolve();
      await forkRejected;
      await close;

      await expect(index.get('dst')).resolves.toMatchObject({ id: 'dst' });
      await expect(
        stat(join(root, 'sessions', 'wd_stub', 'dst', 'state.json')),
      ).resolves.toBeDefined();
      const resumed = await svc.resume('dst');
      expect(resumed?.id).toBe('dst');
    });

    it('preserves a same-id session that registers during the fork collision check', async () => {
      const collisionCheckStarted = deferred();
      const releaseCollisionCheck = deferred();
      const index: ISessionIndex = {
        ...sessionIndexStub(),
        get: async (sessionId: string) => {
          if (sessionId === 'dst') {
            collisionCheckStarted.resolve();
            await releaseCollisionCheck.promise;
          }
          return undefined;
        },
      };
      const svc = build([workspaceGetStub(), stubPair(ISessionIndex, index)]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
      await collisionCheckStarted.promise;
      const replacement = await svc.create({ sessionId: 'dst', workDir: '/tmp/proj' });
      const rejected = expect(forked).rejects.toMatchObject({
        code: ErrorCodes.SESSION_ALREADY_EXISTS,
      });
      releaseCollisionCheck.resolve();
      await rejected;

      expect(svc.get('dst')).toBe(replacement);
      expect(replacement.accessor.get(ISessionContext).sessionId).toBe('dst');
    });

    it('keeps the fork destination exclusively owned through failed copy rollback', async () => {
      const root = await makeTmpRoot();
      const srcDir = join(root, 'sessions', 'wd_stub', 'src');
      const dstDir = join(root, 'sessions', 'wd_stub', 'dst');
      const storage = new FileStorageService(root);
      const copyStarted = deferred();
      const copy = deferred();
      const rollbackStarted = deferred();
      const releaseRollback = deferred();
      const copyFailure = new Error('fork wire copy failed');
      const realHostFs = new HostFileSystem();
      const gatedHostFs = new Proxy(realHostFs, {
        get(target, property, receiver) {
          if (property === 'remove') {
            return async (path: string): Promise<void> => {
              if (path === dstDir) {
                rollbackStarted.resolve();
                await releaseRollback.promise;
              }
              await target.remove(path);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as IHostFileSystem;
      registerScopedService(
        LifecycleScope.Session,
        ISessionMetadata,
        SessionMetadata,
        InstantiationType.Delayed,
        'sessionMetadata',
      );
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(IFileSystemStorageService, storage),
        [IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore)],
        stubPair(IQueryStore, stubQueryStore()),
        stubPair(IFlagService, stubFlag(false)),
        stubPair(ILogService, stubLog()),
        [ISessionIndex, new SyncDescriptor(FileSessionIndex)],
        stubPair(IHostFileSystem, gatedHostFs),
        stubPair(IAppendLogStore, {
          ...appendLogStoreStub(),
          rewrite: () => {
            copyStarted.resolve();
            return copy.promise;
          },
        }),
      ]);
      const source = await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await source.accessor.get(ISessionMetadata).registerAgent('main', {
        homedir: join(srcDir, 'agents', 'main'),
        type: 'main',
      });
      await mkdir(join(srcDir, 'agents', 'main', 'plans'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'main', 'plans', 'p1.md'), '# plan');

      const forked = svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
      await copyStarted.promise;
      const targetStateBefore = await readFile(join(dstDir, 'state.json'), 'utf8');
      await expect(svc.create({ sessionId: 'dst', workDir: '/tmp/proj' })).rejects.toMatchObject({
        code: ErrorCodes.SESSION_ALREADY_EXISTS,
      });
      await expect(readFile(join(dstDir, 'state.json'), 'utf8')).resolves.toBe(targetStateBefore);
      await expect(readFile(join(dstDir, 'agents', 'main', 'plans', 'p1.md'), 'utf8')).resolves.toBe(
        '# plan',
      );

      const forkRejected = expect(forked).rejects.toBe(copyFailure);
      copy.reject(copyFailure);
      await rollbackStarted.promise;
      await expect(svc.create({ sessionId: 'dst', workDir: '/tmp/proj' })).rejects.toMatchObject({
        code: ErrorCodes.SESSION_ALREADY_EXISTS,
      });

      releaseRollback.resolve();
      await forkRejected;
      await expect(stat(dstDir)).rejects.toThrow();
      const index = host!.app.accessor.get(ISessionIndex);
      await expect(index.get('dst')).resolves.toBeUndefined();

      const replacement = await svc.create({ sessionId: 'dst', workDir: '/tmp/proj' });
      const replacementState = JSON.parse(
        await readFile(join(dstDir, 'state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(svc.get('dst')).toBe(replacement);
      expect(replacementState).not.toHaveProperty('forkedFrom');
      await expect(stat(join(dstDir, 'agents', 'main', 'plans', 'p1.md'))).rejects.toThrow();
    });

    it('duplicates the source session cron tasks for the fork', async () => {
      const root = await makeTmpRoot();
      const cron = cronStoreStub([
        {
          id: 'task-src',
          cron: '0 9 * * *',
          prompt: 'standup',
          createdAt: 1,
          tags: { [CRON_SESSION_TAG]: 'src' },
        },
        {
          id: 'task-other',
          cron: '0 9 * * *',
          prompt: 'other',
          createdAt: 1,
          tags: { [CRON_SESSION_TAG]: 'other' },
        },
        { id: 'task-untagged', cron: '* * * * *', prompt: 'x', createdAt: 1 },
      ]);
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(ICronTaskPersistence, cron),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      const all = [...cron.docs.values()];
      expect(all).toHaveLength(4);
      const clone = all.find((task) => task.tags?.[CRON_SESSION_TAG] === 'dst');
      expect(clone).toMatchObject({ cron: '0 9 * * *', prompt: 'standup', createdAt: 1 });
      expect(clone!.id).not.toBe('task-src');
      expect(cron.docs.get('task-src')!.tags![CRON_SESSION_TAG]).toBe('src');
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
