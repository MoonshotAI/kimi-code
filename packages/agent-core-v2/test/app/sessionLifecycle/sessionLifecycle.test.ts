import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IEventService } from '#/app/event/event';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { IAgentPlanService } from '#/agent/plan/plan';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycleService';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
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
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

function bootstrapStub(): IBootstrapService {
  return {
    sessionsDir: '/tmp/sessions',
    homeDir: '/tmp',
    sessionScope: (workspaceId: string, sessionId: string) =>
      `sessions/${workspaceId}/${sessionId}`,
    agentScope: (workspaceId: string, sessionId: string, agentId: string) =>
      `sessions/${workspaceId}/${sessionId}/agents/${agentId}`,
    sessionDir: (workspaceId: string, sessionId: string) =>
      `/tmp/sessions/${workspaceId}/${sessionId}`,
  } as IBootstrapService;
}

function tmpBootstrapStub(root: string): IBootstrapService {
  return {
    sessionsDir: join(root, 'sessions'),
    homeDir: root,
    sessionScope: (workspaceId: string, sessionId: string) =>
      `sessions/${workspaceId}/${sessionId}`,
    agentScope: (workspaceId: string, sessionId: string, agentId: string) =>
      `sessions/${workspaceId}/${sessionId}/agents/${agentId}`,
    sessionDir: (workspaceId: string, sessionId: string) =>
      join(root, 'sessions', workspaceId, sessionId),
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

function agentProfileCatalogStub(): ISessionAgentProfileCatalog {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    get: () => undefined,
    getDefault: () => {
      throw new Error('not implemented');
    },
    list: () => [],
    load: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

function workspaceRegistryStub(): IWorkspaceRegistry {
  return {
    _serviceBrand: undefined,
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    resolveAliasIds: (id) => Promise.resolve([id]),
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
    resolveAliasIds: (id) => Promise.resolve([id]),
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

function sessionToolPolicyStub(): ISessionToolPolicy {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    disabledTools: () => [],
    setDisabledTools: () => Promise.resolve(),
  };
}

function agentLifecycleStub(): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    create: () => Promise.reject(new Error('not implemented')),
    fork: () => Promise.reject(new Error('not implemented')),
    get: () => undefined,
    list: () => [],
    remove: () => Promise.resolve(),
    broadcastPermissionMode: () => {},
  };
}

function sessionMcpServiceStub(
  ensureMcpReady: () => Promise<void> = () => Promise.resolve(),
): ISessionMcpService {
  return {
    _serviceBrand: undefined,
    ensureMcpReady,
    connectionManager: () => {
      throw new Error('not implemented');
    },
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
    get: (id) => (id === MAIN_AGENT_ID ? main : undefined),
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
    get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
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

  function build(extra: ReturnType<typeof stubPair>[] = []): ISessionLifecycleService {
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub()),
      stubPair(ISessionMetadata, metadataStub()),
      stubPair(IHostEnvironment, hostEnvironmentStub()),
      stubPair(ISessionSkillCatalog, skillCatalogStub()),
      stubPair(ISessionToolPolicy, sessionToolPolicyStub()),
      stubPair(ISessionAgentProfileCatalog, agentProfileCatalogStub()),
      stubPair(IWorkspaceRegistry, workspaceRegistryStub()),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(IAppendLogStore, appendLogStoreStub()),
      stubPair(IAtomicDocumentStore, atomicDocumentStoreStub()),
      stubPair(IEventService, eventStub()),
      stubPair(IAgentLifecycleService, agentLifecycleStub()),
      stubPair(ISessionMcpService, sessionMcpServiceStub()),
      stubPair(IConfigService, configStub()),
      stubPair(ISessionCronService, { _serviceBrand: undefined } as unknown as ISessionCronService),
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
    expect(h.kind).toBe(LifecycleScope.Session);
  });

  it('create forwards caller-supplied MCP servers to the session MCP initial load', async () => {
    const ensureMcpReady = vi.fn(() => Promise.resolve());
    const svc = build([
      stubPair(ISessionMcpService, sessionMcpServiceStub(ensureMcpReady)),
    ]);
    const mcpServers = { docs: { transport: 'http', url: 'https://mcp.example.com' } } as const;
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj', mcpServers });
    expect(ensureMcpReady).toHaveBeenCalledWith(mcpServers);
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

    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    // The index entry addresses the session under the registry-resolved
    // workspace id — the same id seeding the session's storage scope — not a
    // recomputed encodeWorkDirKey, so the v1 reader finds it in the bucket it
    // was materialized into.
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
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

  it('does not index and removes a fresh session when initial agent binding fails', async () => {
    const appended: unknown[] = [];
    const remove = vi.fn(() => Promise.resolve());
    const create = vi.fn(() => Promise.reject(new Error('Unknown agent profile')));
    const svc = build([
      stubPair(IAppendLogStore, {
        ...appendLogStoreStub(),
        append: (_scope: string, _key: string, record: unknown) => appended.push(record),
      }),
      stubPair(IHostFileSystem, { remove } as unknown as IHostFileSystem),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create,
      }),
    ]);

    await expect(
      svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        mainAgentBinding: { profile: 'missing', model: 'mock' },
      }),
    ).rejects.toThrow('Unknown agent profile');

    expect(appended).toEqual([]);
    expect(svc.get('s1')).toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('indexes the session under the registry-resolved id when the workDir is an alias spelling', async () => {
    const appended: unknown[] = [];
    const svc = build([
      stubPair(IAppendLogStore, {
        ...appendLogStoreStub(),
        append: (scope: string, key: string, record: unknown) => {
          appended.push({ scope, key, record });
        },
      }),
      stubPair(IWorkspaceRegistry, {
        ...workspaceRegistryStub(),
        // As the real registry does after folding: the id minted for the
        // first-seen spelling is reused for the alias.
        createOrTouch: (root: string, name?: string) =>
          Promise.resolve({
            id: 'wd_first_spelling',
            root,
            name: name ?? 'proj',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
      }),
    ]);

    const handle = await svc.create({ sessionId: 's1', workDir: 'c:\\users\\foo\\proj' });

    expect(handle.accessor.get(ISessionContext).workspaceId).toBe('wd_first_spelling');
    expect(appended).toEqual([
      {
        scope: '',
        key: 'session_index.jsonl',
        record: {
          sessionId: 's1',
          sessionDir: '/tmp/sessions/wd_first_spelling/s1',
          workDir: 'c:\\users\\foo\\proj',
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

  it('does not cache a session whose tool policy fails to initialize', async () => {
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(ISessionToolPolicy, {
        ...sessionToolPolicyStub(),
        ready: Promise.reject(new Error('invalid tool policy')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toThrow('invalid tool policy');
    expect(svc.get('s1')).toBeUndefined();
    await expect(svc.resume('s1')).rejects.toThrow('invalid tool policy');
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
      resolveAliasIds: (id) => Promise.resolve([id]),
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

  it('forks successfully even while the source has a busy agent (crash-equivalent copy)', async () => {
    const busyAgent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentActivityView) {
            return {
              state: () => ({
                lifecycle: 'ready',
                turn: { turnId: 0 },
                background: [],
              }),
            };
          }
          throw new Error('unexpected service access');
        },
      },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = build([
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
        list: () => [busyAgent],
      }),
    ]);

    await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

    // Fork never gates on activity: a mid-work copy is crash-equivalent, and
    // replay already normalizes that on restore.
    const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
    expect(target.id).toBe('dst');
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

  it('emits session_started with resumed: false and the bound session id on create', async () => {
    const svc = build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { sessionId: 's1', resumed: false },
    });
  });

  it('emits session_started with resumed: true and the bound session id on resume', async () => {
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(IWorkspaceRegistry, persistentWorkspaceRegistryStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    await svc.resume('s1');

    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { sessionId: 's1', resumed: true },
    });
  });

  it('emits session_load_failed with the bound session id and the error code when resume fails, then rethrows', async () => {
    const svc = build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new Error2(ErrorCodes.SESSION_NOT_FOUND, 'index read failed')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { sessionId: 's1', reason: ErrorCodes.SESSION_NOT_FOUND },
    });
  });

  it('emits session_load_failed with the bound session id and the error name for plain errors', async () => {
    const svc = build([
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.reject(new TypeError('bad index')),
      }),
    ]);

    await expect(svc.resume('s1')).rejects.toBeInstanceOf(TypeError);
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { sessionId: 's1', reason: 'TypeError' },
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
      stubPair(ISessionMcpService, sessionMcpServiceStub(() => mcpReady)),
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
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
      stubPair(ISessionMcpService, sessionMcpServiceStub(() => mcpReady)),
    ]);

    const resumed = svc.resume('s1');
    await tick();

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
          get: () => mainHandle,
        }),
      ]);

      const h = await svc.resume('s1');

      expect(h).toBeDefined();
      expect(dirsOf(h!)).toEqual(['/tmp/extra']);
    });

    it('fork inherits project-local dirs', async () => {
      const svc = build([
        stubPair(IWorkspaceLocalConfigService, workspaceLocalConfigStub(['/tmp/extra'])),
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
      await expect(stat(join(dstDir, 'state.json'))).rejects.toThrow();
      await expect(stat(join(dstDir, 'agents', 'main', 'wire.jsonl'))).rejects.toThrow();
      await expect(stat(join(dstDir, 'logs'))).rejects.toThrow();
    });

    it('loads the copied session tool policy before returning the fork', async () => {
      const root = await makeTmpRoot();
      const bootstrap = tmpBootstrapStub(root);
      const srcDir = join(root, 'sessions', 'wd_stub', 'src');
      const dstPolicy = join(root, 'sessions', 'wd_stub', 'dst', 'tool-policy', 'state.json');
      let readyCount = 0;
      let disabledTools: readonly string[] = [];
      const policy = {
        ...sessionToolPolicyStub(),
        get ready(): Promise<void> {
          readyCount += 1;
          if (readyCount === 1) return Promise.resolve();
          return readFile(dstPolicy, 'utf8').then((raw) => {
            disabledTools = (JSON.parse(raw) as { disabledTools: readonly string[] }).disabledTools;
          });
        },
        disabledTools: () => disabledTools,
      } satisfies ISessionToolPolicy;
      const svc = build([
        stubPair(IBootstrapService, bootstrap),
        workspaceGetStub(),
        stubPair(ISessionToolPolicy, policy),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await mkdir(join(srcDir, 'tool-policy'), { recursive: true });
      await writeFile(join(srcDir, 'tool-policy', 'state.json'), '{"disabledTools":["Skill"]}');

      const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(target.accessor.get(ISessionToolPolicy).disabledTools()).toEqual(['Skill']);
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
              agents: { main: {} },
            } as never),
        }),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await mkdir(join(srcDir, 'agents', 'main', 'plans'), { recursive: true });
      await writeFile(join(srcDir, 'agents', 'main', 'plans', 'p1.md'), '# plan');
      const dstDir = join(root, 'sessions', 'wd_stub', 'dst');

      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );

      expect(svc.get('dst')).toBeUndefined();
      await expect(stat(dstDir)).rejects.toThrow();
      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );
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
