/**
 * Scenario: session create, resume, replacement, rollback, archive, and fork lifecycle.
 * Responsibilities: publish only ready handles and preserve/remove the matching persisted
 * generation.
 * Wiring: scoped DI host; persistence regressions use real FileStorage/MiniDB, with startup
 * seams stubbed.
 * Run from the package:
 *   pnpm exec vitest run test/app/sessionLifecycle/sessionLifecycle.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
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
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IEventService } from '#/app/event/event';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { IAgentPlanService } from '#/agent/plan/plan';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionSecondaryModelWarningService } from '#/session/subagent/secondaryModelWarning';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycleService';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { FileSessionIndex } from '#/app/sessionIndex/sessionIndexService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';

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
    cacheDir: join(root, 'cache'),
    homeDir: root,
    scope: (name) => name,
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

function workspaceStub(): IWorkspaceService {
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

function projectLocalConfigStub(
  localDirs: readonly string[] = [],
): IProjectLocalConfigService {
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

function persistentWorkspaceStub(): IWorkspaceService {
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
    invalidate: () => Promise.resolve(),
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
    invalidate: () => Promise.resolve(),
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

async function readLegacySessionIndex(root: string): Promise<readonly Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, 'session_index.jsonl'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

function pathAwareHostFileSystemStub(
  remove: (path: string) => Promise<void>,
  pathExists = false,
): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    stat: () =>
      pathExists
        ? Promise.resolve({
            isFile: false,
            isDirectory: true,
            size: 0,
          })
        : Promise.reject(
            new HostFsError(
              OsFsErrors.codes.OS_FS_NOT_FOUND,
              'test session directory does not exist',
            ),
          ),
    remove,
  } as unknown as IHostFileSystem;
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

let disposedSessionScopes: string[] = [];

class RecordingSessionDisposalService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionContext context: ISessionContext) {
    super();
    this._register(
      toDisposable(() => {
        disposedSessionScopes.push(context.sessionId);
      }),
    );
  }
}

class ThrowingSessionDisposalService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  constructor() {
    super();
    this._register({
      dispose: () => {
        throw new Error('session scope disposal failed');
      },
    });
  }
}

let materializeStartupError: Error;

async function mirrorThenReject(metadata: ISessionMetadata): Promise<void> {
  await metadata.update({ title: 'transient' });
  throw materializeStartupError;
}

class FailingSessionToolPolicy implements ISessionToolPolicy {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange = Event.None as ISessionToolPolicy['onDidChange'];

  constructor(@ISessionMetadata metadata: ISessionMetadata) {
    this.ready = mirrorThenReject(metadata);
  }

  disabledTools(): readonly string[] {
    return [];
  }

  setDisabledTools(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingSessionAgentProfileCatalog implements ISessionAgentProfileCatalog {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange =
    Event.None as ISessionAgentProfileCatalog['onDidChange'];

  constructor(@ISessionMetadata metadata: ISessionMetadata) {
    this.ready = mirrorThenReject(metadata);
  }

  get(): undefined {
    return undefined;
  }

  getDefault(): never {
    throw new Error('not implemented');
  }

  list(): readonly never[] {
    return [];
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingSessionMcpService implements ISessionMcpService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionMetadata private readonly metadata: ISessionMetadata) {}

  ensureMcpReady(): Promise<void> {
    return mirrorThenReject(this.metadata);
  }

  connectionManager(): never {
    throw new Error('not implemented');
  }
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
    disposedSessionScopes = [];
    recordedSessionHookEvents = [];
    telemetryRecords = [];
    tmpRoots = [];
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionLifecycleService,
      SessionLifecycleService,
      ScopeActivation.OnDemand,
      'sessionLifecycle',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      NoopSessionExternalHooksService,
      ScopeActivation.OnScopeCreated,
      'externalHooks',
    );
    registerScopedService(
      LifecycleScope.App,
      IHostFileSystem,
      HostFileSystem,
      ScopeActivation.OnDemand,
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
      stubPair(IWorkspaceService, workspaceStub()),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(IAppendLogStore, appendLogStoreStub()),
      stubPair(IAtomicDocumentStore, atomicDocumentStoreStub()),
      stubPair(IEventService, eventStub()),
      stubPair(IAgentLifecycleService, agentLifecycleStub()),
      stubPair(ISessionMcpService, sessionMcpServiceStub()),
      stubPair(IConfigService, configStub()),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.resolve(),
      } as unknown as ISessionCronService),
      stubPair(ISessionSecondaryModelWarningService, {
        _serviceBrand: undefined,
        getSecondaryModelWarning: () => undefined,
      } as ISessionSecondaryModelWarningService),
      stubPair(IProjectLocalConfigService, projectLocalConfigStub()),
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

  function registerRecordingSessionDisposal(): void {
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      RecordingSessionDisposalService,
      ScopeActivation.OnScopeCreated,
      'externalHooks',
    );
  }

  function realAppendLogPair(
    root: string,
    storage: IFileSystemStorageService = new FileStorageService(root),
  ): ReturnType<typeof stubPair> {
    return stubPair(IAppendLogStore, new AppendLogStore(storage));
  }

  function buildReadModel(
    root: string,
    extra: ReturnType<typeof stubPair>[] = [],
    failingBoundary?: 'tool policy' | 'agent profile' | 'MCP',
  ): {
    readonly svc: ISessionLifecycleService;
    readonly index: ISessionIndex;
    readonly queryStore: IQueryStore;
    readonly bootstrap: IBootstrapService;
  } {
    const bootstrap = tmpBootstrapStub(root);
    const fileStorage = new FileStorageService(root);
    const materializationServices: ReturnType<typeof stubPair>[] = [];
    if (failingBoundary === 'tool policy') {
      registerScopedService(
        LifecycleScope.Session,
        ISessionToolPolicy,
        FailingSessionToolPolicy,
        ScopeActivation.OnDemand,
        'failingSessionToolPolicy',
      );
    } else {
      materializationServices.push(stubPair(ISessionToolPolicy, sessionToolPolicyStub()));
    }
    if (failingBoundary === 'agent profile') {
      registerScopedService(
        LifecycleScope.Session,
        ISessionAgentProfileCatalog,
        FailingSessionAgentProfileCatalog,
        ScopeActivation.OnDemand,
        'failingSessionAgentProfileCatalog',
      );
    } else {
      materializationServices.push(
        stubPair(ISessionAgentProfileCatalog, agentProfileCatalogStub()),
      );
    }
    if (failingBoundary === 'MCP') {
      registerScopedService(
        LifecycleScope.Session,
        ISessionMcpService,
        FailingSessionMcpService,
        ScopeActivation.OnDemand,
        'failingSessionMcp',
      );
    } else {
      materializationServices.push(stubPair(ISessionMcpService, sessionMcpServiceStub()));
    }
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      ScopeActivation.OnDemand,
      'storage',
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
      ISessionMetadata,
      SessionMetadata,
      ScopeActivation.OnScopeCreated,
      'sessionMetadata',
    );
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrap),
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IHostEnvironment, hostEnvironmentStub()),
      stubPair(ISessionSkillCatalog, skillCatalogStub()),
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(IAppendLogStore, appendLogStoreStub()),
      stubPair(IEventService, eventStub()),
      stubPair(IAgentLifecycleService, agentLifecycleStub()),
      stubPair(IConfigService, configStub()),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.resolve(),
      } as unknown as ISessionCronService),
      stubPair(ISessionSecondaryModelWarningService, {
        _serviceBrand: undefined,
        getSecondaryModelWarning: () => undefined,
      } as ISessionSecondaryModelWarningService),
      stubPair(IProjectLocalConfigService, projectLocalConfigStub()),
      stubPair(ITelemetryService, recordingTelemetry(telemetryRecords)),
      stubPair(ICronTaskPersistence, cronStoreStub()),
      stubPair(IFlagService, stubFlag(true)),
      stubPair(ILogService, stubLog()),
      ...materializationServices,
      ...extra,
    ]);
    return {
      svc: host.app.accessor.get(ISessionLifecycleService),
      index: host.app.accessor.get(ISessionIndex),
      queryStore: host.app.accessor.get(IQueryStore),
      bootstrap,
    };
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

  it('rollbackResume disposes the expected session after its close hook rejects', async () => {
    registerRecordingSessionDisposal();
    const svc = build();
    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const closeError = new Error('close hook failed');
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));
    const hook = svc.hooks.onWillCloseSession.register('test-close-failure', async () => {
      throw closeError;
    });

    try {
      await expect(svc.close('s1')).rejects.toBe(closeError);
      expect(svc.get('s1')).toBe(handle);

      svc.rollbackResume(handle);

      expect(svc.get('s1')).toBeUndefined();
      expect(disposedSessionScopes).toEqual(['s1']);
      expect(closed).toEqual(['s1']);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
  });

  it('close completes observable teardown when agent draining fails', async () => {
    registerRecordingSessionDisposal();
    const drainError = new Error('agent drain failed');
    const agent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: () => {
          throw new Error('unexpected agent service access');
        },
      },
      dispose: () => {},
    } as IAgentScopeHandle;
    const remove = vi.fn(() => Promise.reject(drainError));
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [agent],
        remove,
      }),
    ]);
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));

    try {
      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      await expect(svc.close('s1')).rejects.toBe(drainError);

      expect(remove).toHaveBeenCalledWith(MAIN_AGENT_ID);
      expect(svc.get('s1')).toBeUndefined();
      expect(disposedSessionScopes).toEqual(['s1']);
      expect(closed).toEqual(['s1']);
    } finally {
      subscription.dispose();
    }
  });

  it('rollbackResume is idempotent for the same session handle', async () => {
    registerRecordingSessionDisposal();
    const svc = build();
    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));

    try {
      svc.rollbackResume(handle);
      svc.rollbackResume(handle);

      expect(svc.get('s1')).toBeUndefined();
      expect(disposedSessionScopes).toEqual(['s1']);
      expect(closed).toEqual(['s1']);
    } finally {
      subscription.dispose();
    }
  });

  it('rollbackResume restores the live generation replaced by a completed resume', async () => {
    let releaseIndex!: (summary: SessionSummary) => void;
    const indexResult = new Promise<SessionSummary>((resolve) => {
      releaseIndex = resolve;
    });
    let markIndexRead!: () => void;
    const indexRead = new Promise<void>((resolve) => {
      markIndexRead = resolve;
    });
    const svc = build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => {
          markIndexRead();
          return indexResult;
        },
      }),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resuming = svc.resume('s1');
    await indexRead;
    const original = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    releaseIndex({
      id: 's1',
      workspaceId: encodeWorkDirKey('/tmp/proj'),
      cwd: '/tmp/proj',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    const replacement = await resuming;

    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(original);

    svc.rollbackResume(replacement!);

    expect(svc.get('s1')).toBe(original);
    expect(svc.list()).toEqual([original]);
  });

  it('splices a rolled-back middle generation so rolling back its successor restores the original', async () => {
    const svc = build();
    const original = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const middle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const current = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    svc.rollbackResume(middle);

    expect(svc.get('s1')).toBe(current);

    svc.rollbackResume(current);

    expect(svc.get('s1')).toBe(original);
    expect(svc.list()).toEqual([original]);
  });

  it('close drains every hidden generation without restoring an older handle', async () => {
    registerRecordingSessionDisposal();
    const svc = build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));

    try {
      await svc.close('s1');

      expect(svc.get('s1')).toBeUndefined();
      expect(svc.list()).toEqual([]);
      expect(disposedSessionScopes).toEqual(['s1', 's1']);
      expect(closed).toEqual(['s1']);
    } finally {
      subscription.dispose();
    }
  });

  it('close leaves a new generation created during hidden-generation draining current', async () => {
    registerRecordingSessionDisposal();
    const agent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: () => {
          throw new Error('unexpected agent service access');
        },
      },
      dispose: () => {},
    } as IAgentScopeHandle;
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    let releaseDrain!: () => void;
    const drainReleased = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let removeCalls = 0;
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [agent],
        remove: async () => {
          if (removeCalls++ === 0) {
            markDrainStarted();
            await drainReleased;
          }
        },
      }),
    ]);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));

    try {
      const closing = svc.close('s1');
      await drainStarted;
      const current = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
      releaseDrain();
      await closing;

      expect(svc.get('s1')).toBe(current);
      expect(svc.list()).toEqual([current]);
      expect(disposedSessionScopes).toEqual(['s1', 's1']);
      expect(closed).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  it('archive skips stale persistence and events when its handle is replaced in the close hook', async () => {
    registerRecordingSessionDisposal();
    const root = await makeTmpRoot();
    const { svc } = buildReadModel(root);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const stale = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const setArchived = vi.spyOn(stale.accessor.get(ISessionMetadata), 'setArchived');
    let current: typeof stale | undefined;
    const archived: string[] = [];
    const subscription = svc.onDidArchiveSession((event) => archived.push(event.sessionId));
    const hook = svc.hooks.onWillCloseSession.register(
      'replace-before-archive-commit',
      async (event, next) => {
        if (event.handle === stale) {
          current = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
        }
        await next();
      },
    );

    try {
      await svc.archive('s1');

      expect(current).toBeDefined();
      expect(svc.get('s1')).toBe(current);
      expect(setArchived).not.toHaveBeenCalled();
      expect(disposedSessionScopes).toEqual(['s1', 's1']);
      expect(archived).toEqual([]);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
  });

  it('close leaves a replacement session installed by its hook live', async () => {
    registerRecordingSessionDisposal();
    const svc = build();
    const stale = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    let replacement: typeof stale | undefined;
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));
    const hook = svc.hooks.onWillCloseSession.register(
      'test-concurrent-replacement',
      async (event, next) => {
        if (event.handle === stale) {
          replacement = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
        }
        await next();
      },
    );

    try {
      await svc.close('s1');

      expect(replacement).toBeDefined();
      expect(svc.get('s1')).toBe(replacement);
      expect(svc.list()).toEqual([replacement]);
      expect(disposedSessionScopes).toEqual(['s1']);
      expect(closed).toEqual([]);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
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
      stubPair(IHostFileSystem, pathAwareHostFileSystemStub(remove)),
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
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
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
    const workspaces = persistentWorkspaceStub();
    const sessionIndex = sessionIndexWithSummary('s1', workDir);
    const first = build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(ISessionIndex, sessionIndex),
    ]);

    await first.create({ sessionId: 's1', workDir });
    await expect(workspaces.get(encodeWorkDirKey(workDir))).resolves.toMatchObject({
      root: workDir,
    });
    host?.dispose();
    host = undefined;

    const second = build([
      stubPair(IWorkspaceService, workspaces),
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
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume('s1');

    expect(resumed?.id).toBe('s1');
    expect(resumed?.accessor.get(ISessionContext).workspaceId).toBe(encodeWorkDirKey(workDir));
  });

  it('does not cache a session whose tool policy fails to initialize', async () => {
    const invalidToolPolicy = sessionToolPolicyStub();
    Object.defineProperty(invalidToolPolicy, 'ready', {
      get: () => Promise.reject(new Error('invalid tool policy')),
    });
    const svc = build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(ISessionToolPolicy, invalidToolPolicy),
    ]);

    await expect(svc.resume('s1')).rejects.toThrow('invalid tool policy');
    expect(svc.get('s1')).toBeUndefined();
    await expect(svc.resume('s1')).rejects.toThrow('invalid tool policy');
  });

  it('resumes with the persisted cwd and indexed workspace id when the registry root is stale', async () => {
    const workDir = '/tmp/proj';
    const staleRoot = '/tmp/stale';
    const indexedWorkspaceId = 'wd_indexed';
    const workspaces: IWorkspaceService = {
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
      stubPair(IWorkspaceService, workspaces),
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
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
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

  it('rolls back fresh persistence when a creation hook returns without reaching next', async () => {
    const root = await makeTmpRoot();
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      realAppendLogPair(root),
    ]);
    const created: string[] = [];
    const subscription = svc.onDidCreateSession((event) => created.push(event.sessionId));
    const hook = svc.hooks.onDidCreateSession.register('stop-before-terminal', async (event) => {
      await event.handle.accessor.get(ISessionMetadata).update({ title: 'transient' });
    });

    try {
      await expect(
        svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
      ).rejects.toThrow('Session creation hooks did not reach the lifecycle terminal');

      expect(svc.get('s1')).toBeUndefined();
      expect(await queryStore.get('session', 's1')).toBeUndefined();
      expect(await index.get('s1')).toBeUndefined();
      await expect(
        stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readLegacySessionIndex(root)).toEqual([]);
      expect(created).toEqual([]);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
  });

  it('awaits a fire-and-forget next and rolls back when its terminal rejects', async () => {
    const root = await makeTmpRoot();
    const terminalError = new Error('cron terminal failed');
    let markCronStarted!: () => void;
    const cronStarted = new Promise<void>((resolve) => {
      markCronStarted = resolve;
    });
    let rejectCron!: (error: Error) => void;
    const cronTerminal = new Promise<void>((_resolve, reject) => {
      rejectCron = reject;
    });
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => {
          markCronStarted();
          return cronTerminal;
        },
      } as unknown as ISessionCronService),
    ]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const created: string[] = [];
    const subscription = svc.onDidCreateSession((event) => created.push(event.sessionId));
    const hook = svc.hooks.onDidCreateSession.register(
      'fire-and-forget-terminal',
      (_event, next) => {
        void next();
      },
    );

    try {
      let settled = false;
      const outcomePromise = svc
        .create({ sessionId: 's1', workDir: '/tmp/proj' })
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        )
        .finally(() => {
          settled = true;
        });

      await cronStarted;
      await Promise.resolve();
      expect(settled).toBe(false);

      rejectCron(terminalError);
      const outcome = await outcomePromise;
      expect(outcome).toEqual({ status: 'rejected', error: terminalError });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(svc.get('s1')).toBeUndefined();
      expect(await queryStore.get('session', 's1')).toBeUndefined();
      expect(await index.get('s1')).toBeUndefined();
      await expect(
        stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(created).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      hook.dispose();
      subscription.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('runs the terminal and legacy append once when a hook calls next repeatedly', async () => {
    const root = await makeTmpRoot();
    const start = vi.fn(() => Promise.resolve());
    const { svc } = buildReadModel(root, [
      realAppendLogPair(root),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start,
      } as unknown as ISessionCronService),
    ]);
    const created: string[] = [];
    const subscription = svc.onDidCreateSession((event) => created.push(event.sessionId));
    const hook = svc.hooks.onDidCreateSession.register(
      'repeat-terminal',
      async (_event, next) => {
        await Promise.all([next(), next(), next()]);
      },
    );

    try {
      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(start).toHaveBeenCalledOnce();
      expect(await readLegacySessionIndex(root)).toHaveLength(1);
      expect(created).toEqual(['s1']);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
  });

  it('retains committed persistence when the legacy append result is ambiguous', async () => {
    const root = await makeTmpRoot();
    const appendError = new Error('append durability acknowledgement failed');
    const storage = new FileStorageService(root);
    const ambiguousStorage = Object.create(storage) as IFileSystemStorageService;
    ambiguousStorage.append = async (scope, key, data, options) => {
      await storage.append(scope, key, data, options);
      throw appendError;
    };
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      realAppendLogPair(root, ambiguousStorage),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    const created: string[] = [];
    const subscription = svc.onDidCreateSession((event) => created.push(event.source));
    const hook = svc.hooks.onDidCreateSession.register(
      'mirror-before-append',
      async (event, next) => {
        if (event.source === 'startup') {
          await event.handle.accessor.get(ISessionMetadata).update({ title: 'durable' });
        }
        await next();
      },
    );

    try {
      await expect(
        svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
      ).rejects.toBe(appendError);

      expect(svc.get('s1')).toBeUndefined();
      expect(await queryStore.get('session', 's1')).toMatchObject({ title: 'durable' });
      expect(await index.get('s1')).toMatchObject({ title: 'durable' });
      expect(
        (await stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1'))).isDirectory(),
      ).toBe(true);
      expect(await readLegacySessionIndex(root)).toHaveLength(1);
      expect(created).toEqual([]);

      const resumed = await svc.resume('s1');
      expect(resumed?.id).toBe('s1');
      expect(svc.get('s1')).toBe(resumed);
      expect(created).toEqual(['resume']);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
  });

  it('retains committed persistence when a creation hook throws after next', async () => {
    const root = await makeTmpRoot();
    const hookError = new Error('post-terminal hook failed');
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      realAppendLogPair(root),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    const created: string[] = [];
    const subscription = svc.onDidCreateSession((event) => created.push(event.source));
    const hook = svc.hooks.onDidCreateSession.register(
      'throw-after-terminal',
      async (event, next) => {
        if (event.source === 'startup') {
          await event.handle.accessor.get(ISessionMetadata).update({ title: 'durable' });
          await next();
          throw hookError;
        }
        await next();
      },
    );

    try {
      await expect(
        svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
      ).rejects.toBe(hookError);

      expect(svc.get('s1')).toBeUndefined();
      expect(await queryStore.get('session', 's1')).toMatchObject({ title: 'durable' });
      expect(await index.get('s1')).toMatchObject({ title: 'durable' });
      expect(
        (await stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1'))).isDirectory(),
      ).toBe(true);
      expect(await readLegacySessionIndex(root)).toHaveLength(1);
      expect(created).toEqual([]);

      const resumed = await svc.resume('s1');
      expect(resumed?.id).toBe('s1');
      expect(svc.get('s1')).toBe(resumed);
      expect(created).toEqual(['resume']);
    } finally {
      hook.dispose();
      subscription.dispose();
    }
  });

  it.each(['cron', 'pre-terminal hook'] as const)(
    'keeps the old workspace mapping and legacy line when a new workspace %s fails',
    async (boundary) => {
      const root = await makeTmpRoot();
      const failure = new Error(`${boundary} failed`);
      let cronStarts = 0;
      const { svc, index, bootstrap } = buildReadModel(root, [
        realAppendLogPair(root),
        stubPair(ISessionCronService, {
          _serviceBrand: undefined,
          start: () => {
            cronStarts += 1;
            return boundary === 'cron' && cronStarts === 2
              ? Promise.reject(failure)
              : Promise.resolve();
          },
        } as unknown as ISessionCronService),
      ]);
      const hook = svc.hooks.onDidCreateSession.register(
        'fail-new-workspace-before-terminal',
        async (event, next) => {
          if (
            boundary === 'pre-terminal hook' &&
            event.handle.accessor.get(ISessionContext).cwd === '/tmp/new-proj'
          ) {
            throw failure;
          }
          await next();
        },
      );

      try {
        const original = await svc.create({ sessionId: 's1', workDir: '/tmp/old-proj' });
        await original.accessor.get(ISessionMetadata).update({ title: 'original' });
        await svc.close('s1');

        await expect(
          svc.create({ sessionId: 's1', workDir: '/tmp/new-proj' }),
        ).rejects.toBe(failure);

        expect(svc.get('s1')).toBeUndefined();
        expect(await index.get('s1')).toMatchObject({
          id: 's1',
          workspaceId: encodeWorkDirKey('/tmp/old-proj'),
          cwd: '/tmp/old-proj',
          title: 'original',
        });
        expect(await readLegacySessionIndex(root)).toEqual([
          {
            sessionId: 's1',
            sessionDir: bootstrap.sessionDir(encodeWorkDirKey('/tmp/old-proj'), 's1'),
            workDir: '/tmp/old-proj',
          },
        ]);
        expect(
          (await stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/old-proj'), 's1'))).isDirectory(),
        ).toBe(true);
        await expect(
          stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/new-proj'), 's1')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        hook.dispose();
      }
    },
  );

  it('rejects a saved next after a failed resume without running the terminal later', async () => {
    const root = await makeTmpRoot();
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
    let liveMain: IAgentScopeHandle | undefined;
    const createAgent = vi.fn(() => {
      liveMain = main;
      return Promise.resolve(main);
    });
    const start = vi.fn(() => Promise.resolve());
    const { svc } = buildReadModel(root, [
      realAppendLogPair(root),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        get: (id) => (id === MAIN_AGENT_ID ? liveMain : undefined),
        create: createAgent,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start,
      } as unknown as ISessionCronService),
    ]);
    const created = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await created.accessor.get(ISessionMetadata).update({ title: 'persisted' });
    await svc.close('s1');
    createAgent.mockClear();
    start.mockClear();
    let savedNext: (() => Promise<void>) | undefined;
    const hook = svc.hooks.onDidCreateSession.register('save-next', (_event, next) => {
      savedNext = () => next();
    });

    try {
      await expect(svc.resume('s1')).rejects.toThrow(
        'Session creation hooks did not reach the lifecycle terminal',
      );
      expect(svc.get('s1')).toBeUndefined();
      expect(savedNext).toBeDefined();

      await expect(savedNext!()).rejects.toThrow(
        'Session creation hook terminal is already closed',
      );

      expect(createAgent).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(svc.get('s1')).toBeUndefined();
    } finally {
      hook.dispose();
    }
  });

  it('rejects creation as no longer current when a created listener disposes its handle', async () => {
    const svc = build();
    const events: string[] = [];
    const subscription = svc.onDidCreateSession((event) => {
      events.push(`created:${event.sessionId}`);
      event.handle.dispose();
    });

    try {
      await expect(
        svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });

      expect(events).toEqual(['created:s1']);
      expect(svc.get('s1')).toBeUndefined();
      expect(svc.list()).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  it('rejects creation without returning an orphan when its created listener rolls it back', async () => {
    const svc = build();
    const events: string[] = [];
    const createdSubscription = svc.onDidCreateSession((event) => {
      events.push(`created:${event.sessionId}`);
      svc.rollbackResume(event.handle);
    });
    const closedSubscription = svc.onDidCloseSession((event) => {
      events.push(`closed:${event.sessionId}`);
    });

    try {
      await expect(
        svc.create({ sessionId: 's1', workDir: '/tmp/proj' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });

      expect(svc.get('s1')).toBeUndefined();
      expect(svc.list()).toEqual([]);
      expect(events).toEqual(['created:s1', 'closed:s1']);
    } finally {
      createdSubscription.dispose();
      closedSubscription.dispose();
    }
  });

  it('rejects fork without publishing create when its fork listener rolls the target back', async () => {
    const svc = build([
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
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
    const source = await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
    const events: string[] = [];
    const forkedSubscription = svc.onDidForkSession((event) => {
      events.push(`forked:${event.sessionId}`);
      svc.rollbackResume(event.handle);
    });
    const createdSubscription = svc.onDidCreateSession((event) => {
      events.push(`created:${event.sessionId}`);
    });
    const closedSubscription = svc.onDidCloseSession((event) => {
      events.push(`closed:${event.sessionId}`);
    });

    try {
      await expect(
        svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });

      expect(svc.get('src')).toBe(source);
      expect(svc.get('dst')).toBeUndefined();
      expect(events).toEqual(['forked:dst', 'closed:dst']);
    } finally {
      forkedSubscription.dispose();
      createdSubscription.dispose();
      closedSubscription.dispose();
    }
  });

  it('runs creation hooks before starting the session cron scheduler', async () => {
    const order: string[] = [];
    const svc = build([
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => {
          order.push('cron');
          return Promise.resolve();
        },
      } as unknown as ISessionCronService),
    ]);
    svc.hooks.onDidCreateSession.register('observer', async (_event, next) => {
      order.push('observer');
      await next();
    });

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    expect(order).toEqual(['observer', 'cron']);
  });

  it('lets resume hooks observe main-agent creation before restore producers start', async () => {
    const order: string[] = [];
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
    let liveMain: IAgentScopeHandle | undefined;
    const svc = build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj')),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        get: (id: string) => (id === MAIN_AGENT_ID ? liveMain : undefined),
        create: () => {
          order.push('main');
          liveMain = main;
          return Promise.resolve(main);
        },
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => {
          order.push('cron');
          return Promise.resolve();
        },
      } as unknown as ISessionCronService),
    ]);
    svc.hooks.onDidCreateSession.register('observer', async (_event, next) => {
      order.push('observer-before');
      await next();
      order.push('observer-after');
    });

    await svc.resume('s1');

    expect(order).toEqual(['observer-before', 'main', 'cron', 'observer-after']);
  });

  it('removes a fresh session when cron scheduler startup fails', async () => {
    const startupError = new Error('cron startup failed');
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
    let liveMain: IAgentScopeHandle | undefined;
    const removeAgent = vi.fn((agentId: string) => {
      if (liveMain?.id === agentId) liveMain = undefined;
      return Promise.resolve();
    });
    const removeSessionDir = vi.fn(() => Promise.resolve());
    registerRecordingSessionDisposal();
    const svc = build([
      stubPair(IHostFileSystem, pathAwareHostFileSystemStub(removeSessionDir)),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => {
          liveMain = main;
          return Promise.resolve(main);
        },
        get: (id: string) => (id === MAIN_AGENT_ID ? liveMain : undefined),
        list: () => (liveMain === undefined ? [] : [liveMain]),
        remove: removeAgent,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.reject(startupError),
      } as unknown as ISessionCronService),
    ]);
    const created: string[] = [];
    svc.onDidCreateSession((event) => created.push(event.sessionId));

    await expect(
      svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        mainAgentBinding: { profile: 'agent', model: 'mock' },
      }),
    ).rejects.toBe(startupError);

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);
    expect(created).toEqual([]);
    expect(removeAgent).toHaveBeenCalledWith(MAIN_AGENT_ID);
    expect(removeSessionDir).toHaveBeenCalledOnce();
    expect(disposedSessionScopes).toEqual(['s1']);
  });

  it('removes mirrored read-model metadata when cron startup rolls back creation', async () => {
    const root = await makeTmpRoot();
    const startupError = new Error('cron startup failed');
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.reject(startupError),
      } as unknown as ISessionCronService),
    ]);
    svc.hooks.onDidCreateSession.register('mirror-before-cron', async (event, next) => {
      await event.handle.accessor.get(ISessionMetadata).update({ title: 'transient' });
      await next();
    });

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(startupError);

    expect(await queryStore.get('session', 's1')).toBeUndefined();
    await expect(
      stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await index.get('s1')).toBeUndefined();
  });

  it.each(['tool policy', 'agent profile', 'MCP'] as const)(
    'removes fresh persistence after %s materialization fails without masking the failure',
    async (boundary) => {
      registerScopedService(
        LifecycleScope.Session,
        ISessionExternalHooksService,
        ThrowingSessionDisposalService,
        ScopeActivation.OnScopeCreated,
        'externalHooks',
      );
      const root = await makeTmpRoot();
      materializeStartupError = new Error(`${boundary} materialization failed`);
      const { svc, index, queryStore, bootstrap } = buildReadModel(root, [], boundary);
      const workspaceId = encodeWorkDirKey('/tmp/proj');

      await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(
        materializeStartupError,
      );

      expect(await queryStore.get('session', 's1')).toBeUndefined();
      await expect(stat(bootstrap.sessionDir(workspaceId, 's1'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await index.get('s1')).toBeUndefined();
    },
  );

  it('keeps a nested replacement durable when the outer create hook fails', async () => {
    const root = await makeTmpRoot();
    const startupError = new Error('first create hook failed');
    const { svc, index, queryStore, bootstrap } = buildReadModel(root);
    let first = true;
    let replacement: ReturnType<ISessionLifecycleService['get']>;
    svc.hooks.onDidCreateSession.register('replace-first-create', async (event, next) => {
      if (first) {
        first = false;
        replacement = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
        throw startupError;
      }
      await event.handle.accessor.get(ISessionMetadata).update({ title: 'replacement' });
      await next();
    });

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(startupError);

    expect(replacement).toBeDefined();
    expect(svc.get('s1')).toBe(replacement);
    expect(await queryStore.get('session', 's1')).toMatchObject({ title: 'replacement' });
    expect(await index.get('s1')).toMatchObject({ title: 'replacement' });
    expect(
      (await stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1'))).isDirectory(),
    ).toBe(true);
  });

  it.each(['agent drain', 'directory removal'] as const)(
    'serializes a same-path replacement across rollback %s',
    async (blockedCleanup) => {
      const root = await makeTmpRoot();
      const startupError = new Error('outer cron startup failed');
      let enterCleanup!: () => void;
      const cleanupEntered = new Promise<void>((resolve) => {
        enterCleanup = resolve;
      });
      let releaseCleanup!: () => void;
      const cleanupReleased = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let cleanupCalls = 0;
      let liveMain: IAgentScopeHandle | undefined;
      const makeMain = (): IAgentScopeHandle =>
        ({
          id: MAIN_AGENT_ID,
          kind: LifecycleScope.Agent,
          accessor: {
            get: () => {
              throw new Error('unexpected main agent service access');
            },
          },
          dispose: () => {},
        }) as IAgentScopeHandle;
      const agents: IAgentLifecycleService = {
        ...agentLifecycleStub(),
        create: () => {
          liveMain = makeMain();
          return Promise.resolve(liveMain);
        },
        get: (agentId) => (agentId === MAIN_AGENT_ID ? liveMain : undefined),
        list: () => (liveMain === undefined ? [] : [liveMain]),
        remove: async (agentId) => {
          if (blockedCleanup === 'agent drain' && cleanupCalls++ === 0) {
            enterCleanup();
            await cleanupReleased;
          }
          if (liveMain?.id === agentId) liveMain = undefined;
        },
      };
      const extra: ReturnType<typeof stubPair>[] = [stubPair(IAgentLifecycleService, agents)];
      if (blockedCleanup === 'directory removal') {
        const realHostFs = new HostFileSystem();
        const blockingHostFs = Object.create(realHostFs) as IHostFileSystem;
        blockingHostFs.remove = async (path: string) => {
          if (cleanupCalls++ === 0) {
            enterCleanup();
            await cleanupReleased;
          }
          await realHostFs.remove(path);
        };
        extra.push(stubPair(IHostFileSystem, blockingHostFs));
      }
      let cronStarts = 0;
      extra.push(
        stubPair(ISessionCronService, {
          _serviceBrand: undefined,
          start: () => {
            cronStarts += 1;
            return cronStarts === 1 ? Promise.reject(startupError) : Promise.resolve();
          },
        } as unknown as ISessionCronService),
      );
      const { svc, index, queryStore, bootstrap } = buildReadModel(root, extra);
      let hookCalls = 0;
      svc.hooks.onDidCreateSession.register('mirror-replacement', async (event, next) => {
        hookCalls += 1;
        await event.handle.accessor.get(ISessionMetadata).update({
          title: hookCalls === 1 ? 'outer' : 'replacement',
        });
        await next();
      });
      const createOptions = {
        sessionId: 's1',
        workDir: '/tmp/proj',
        mainAgentBinding: { profile: 'agent', model: 'mock' },
      } as const;
      const failedCreate = svc.create(createOptions).then(
        () => undefined,
        (error: unknown) => error,
      );
      await cleanupEntered;

      let replacementSettled = false;
      const replacementPromise = svc.create(createOptions);
      void replacementPromise.then(
        () => {
          replacementSettled = true;
        },
        () => {
          replacementSettled = true;
        },
      );
      for (let turn = 0; turn < 64; turn += 1) {
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
      const settledBeforeCleanup = replacementSettled;
      releaseCleanup();

      expect(await failedCreate).toBe(startupError);
      const replacement = await replacementPromise;

      expect(settledBeforeCleanup).toBe(false);
      expect(svc.get('s1')).toBe(replacement);
      expect(await queryStore.get('session', 's1')).toMatchObject({ title: 'replacement' });
      expect(await index.get('s1')).toMatchObject({ title: 'replacement' });
      expect(
        JSON.parse(
          await readFile(
            join(
              bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1'),
              'state.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({ title: 'replacement' });
    },
  );

  it('removes only the failed fresh workspace when another workspace persists the same id', async () => {
    const root = await makeTmpRoot();
    const startupError = new Error('workspace B cron startup failed');
    let cronStarts = 0;
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => {
          cronStarts += 1;
          return cronStarts === 1 ? Promise.resolve() : Promise.reject(startupError);
        },
      } as unknown as ISessionCronService),
    ]);
    svc.hooks.onDidCreateSession.register('mirror-workspace', async (event, next) => {
      const workspaceId = event.handle.accessor.get(ISessionContext).workspaceId;
      await event.handle.accessor.get(ISessionMetadata).update({
        title:
          workspaceId === encodeWorkDirKey('/tmp/workspace-a')
            ? 'workspace A'
            : 'workspace B',
      });
      await next();
    });

    await svc.create({ sessionId: 's1', workDir: '/tmp/workspace-a' });
    await svc.close('s1');

    await expect(
      svc.create({ sessionId: 's1', workDir: '/tmp/workspace-b' }),
    ).rejects.toBe(startupError);

    const workspaceA = encodeWorkDirKey('/tmp/workspace-a');
    const workspaceB = encodeWorkDirKey('/tmp/workspace-b');
    const metadataA = JSON.parse(
      await readFile(join(bootstrap.sessionDir(workspaceA, 's1'), 'state.json'), 'utf8'),
    ) as { title?: string };
    expect(metadataA.title).toBe('workspace A');
    await expect(stat(bootstrap.sessionDir(workspaceB, 's1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await queryStore.get('session', 's1')).toBeUndefined();
    expect(await index.get('s1')).toMatchObject({
      workspaceId: workspaceA,
      title: 'workspace A',
    });
  });

  it.each(['without metadata', 'with corrupt metadata'] as const)(
    'preserves a pre-existing session directory %s when creation fails',
    async (existingState) => {
      const root = await makeTmpRoot();
      const startupError = new Error('cron startup failed');
      const bootstrap = tmpBootstrapStub(root);
      const sessionDir = bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'sentinel.txt'), 'keep me');
      if (existingState === 'with corrupt metadata') {
        await writeFile(join(sessionDir, 'state.json'), '{not-json');
      }
      const { svc } = buildReadModel(root, [
        stubPair(ISessionCronService, {
          _serviceBrand: undefined,
          start: () => Promise.reject(startupError),
        } as unknown as ISessionCronService),
      ]);

      await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBeDefined();

      expect(await readFile(join(sessionDir, 'sentinel.txt'), 'utf8')).toBe('keep me');
    },
  );

  it('does not delete a persisted session when replacement startup fails', async () => {
    const remove = vi.fn(() => Promise.resolve());
    const invalidate = vi.fn(() => Promise.resolve());
    const startupError = new Error('cron startup failed');
    const summary = {
      id: 's1',
      workspaceId: 'wd_stub',
      cwd: '/tmp/proj',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    } satisfies SessionSummary;
    const svc = build([
      stubPair(IHostFileSystem, pathAwareHostFileSystemStub(remove, true)),
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        get: () => Promise.resolve(summary),
        invalidate,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.reject(startupError),
      } as unknown as ISessionCronService),
    ]);

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(startupError);

    expect(remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('restores the previous live handle when replacement startup fails', async () => {
    const remove = vi.fn(() => Promise.resolve());
    const invalidate = vi.fn(() => Promise.resolve());
    const startupError = new Error('replacement cron startup failed');
    let cronStarts = 0;
    const svc = build([
      stubPair(IHostFileSystem, pathAwareHostFileSystemStub(remove)),
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        invalidate,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => {
          cronStarts += 1;
          return cronStarts === 1 ? Promise.resolve() : Promise.reject(startupError);
        },
      } as unknown as ISessionCronService),
    ]);
    const existing = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(startupError);

    expect(svc.get('s1')).toBe(existing);
    expect(remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('preserves the startup error when rollback cleanup fails', async () => {
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      ThrowingSessionDisposalService,
      ScopeActivation.OnScopeCreated,
      'externalHooks',
    );
    const startupError = new Error('cron startup failed');
    const invalidate = vi.fn(() => Promise.resolve());
    const agent = {
      id: MAIN_AGENT_ID,
      kind: LifecycleScope.Agent,
      accessor: { get: () => ({}) },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [agent],
        remove: () => Promise.reject(new Error('agent removal failed')),
      }),
      stubPair(
        IHostFileSystem,
        pathAwareHostFileSystemStub(() =>
          Promise.reject(new Error('session directory removal failed')),
        ),
      ),
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        invalidate,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.reject(startupError),
      } as unknown as ISessionCronService),
    ]);

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(startupError);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('preserves the startup error when read-model invalidation fails', async () => {
    const startupError = new Error('cron startup failed');
    const invalidate = vi.fn(() => Promise.reject(new Error('read-model invalidation failed')));
    const svc = build([
      stubPair(IHostFileSystem, pathAwareHostFileSystemStub(() => Promise.resolve())),
      stubPair(ISessionIndex, {
        ...sessionIndexStub(),
        invalidate,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => Promise.reject(startupError),
      } as unknown as ISessionCronService),
    ]);

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toBe(startupError);

    expect(invalidate).toHaveBeenCalledWith('s1', 'wd_stub');
  });

  it('emits session_started with resumed: false and the bound session id on create', async () => {
    const svc = build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { sessionId: 's1', resumed: false },
    });
  });

  it('keeps telemetry session context isolated when multiple sessions emit interleaved events', async () => {
    const svc = build();
    const first = await svc.create({ sessionId: 'first', workDir: '/tmp/proj' });
    const second = await svc.create({ sessionId: 'second', workDir: '/tmp/proj' });
    telemetryRecords.length = 0;

    first.accessor.get(ITelemetryService).track('test_event', { marker: 'first-before' });
    second.accessor.get(ITelemetryService).track('test_event', { marker: 'second' });
    first.accessor.get(ITelemetryService).track('test_event', { marker: 'first-after' });

    expect(telemetryRecords).toEqual([
      {
        event: 'test_event',
        properties: { sessionId: 'first', marker: 'first-before' },
      },
      {
        event: 'test_event',
        properties: { sessionId: 'second', marker: 'second' },
      },
      {
        event: 'test_event',
        properties: { sessionId: 'first', marker: 'first-after' },
      },
    ]);
  });

  it('emits session_started with resumed: true and the bound session id on resume', async () => {
    const workDir = '/tmp/proj';
    const svc = build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
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

  it('keeps persisted state intact so a cron-failed resume can be retried', async () => {
    const root = await makeTmpRoot();
    const startupError = new Error('cron startup failed');
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
    let liveMain: IAgentScopeHandle | undefined;
    let cronStarts = 0;
    const removeAgent = vi.fn((agentId: string) => {
      if (liveMain?.id === agentId) liveMain = undefined;
      return Promise.resolve();
    });
    registerRecordingSessionDisposal();
    const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => {
          liveMain = main;
          return Promise.resolve(main);
        },
        get: (id: string) => (id === MAIN_AGENT_ID ? liveMain : undefined),
        list: () => (liveMain === undefined ? [] : [liveMain]),
        remove: removeAgent,
      }),
      stubPair(ISessionCronService, {
        _serviceBrand: undefined,
        start: () => {
          cronStarts += 1;
          return cronStarts === 2 ? Promise.reject(startupError) : Promise.resolve();
        },
      } as unknown as ISessionCronService),
    ]);
    const created = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await created.accessor.get(ISessionMetadata).update({ title: 'persisted' });
    await svc.close('s1');
    disposedSessionScopes = [];

    await expect(svc.resume('s1')).rejects.toBe(startupError);

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);
    expect(removeAgent).toHaveBeenCalledWith(MAIN_AGENT_ID);
    expect(disposedSessionScopes).toEqual(['s1']);
    expect(await queryStore.get('session', 's1')).toMatchObject({ title: 'persisted' });
    expect(await index.get('s1')).toMatchObject({ title: 'persisted' });
    expect(
      JSON.parse(
        await readFile(
          join(
            bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 's1'),
            'state.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ title: 'persisted' });
    expect(telemetryRecords).toContainEqual({
      event: 'session_load_failed',
      properties: { sessionId: 's1', reason: 'Error' },
    });

    const retried = await svc.resume('s1');

    expect(retried?.id).toBe('s1');
    expect(svc.get('s1')).toBe(retried);
  });

  it('runs constructor-registered session lifecycle hooks before returning create and close', async () => {
    registerScopedService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      RecordingSessionExternalHooksService,
      ScopeActivation.OnScopeCreated,
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

  it('publishes close and disposes the scope once when close is called concurrently', async () => {
    registerRecordingSessionDisposal();
    const svc = build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const closed: string[] = [];
    const subscription = svc.onDidCloseSession((event) => closed.push(event.sessionId));

    try {
      await Promise.all([svc.close('s1'), svc.close('s1')]);

      expect(svc.get('s1')).toBeUndefined();
      expect(disposedSessionScopes).toEqual(['s1']);
      expect(closed).toEqual(['s1']);
    } finally {
      subscription.dispose();
    }
  });

  it('publishes archive and disposes the scope once when archive is called concurrently', async () => {
    registerRecordingSessionDisposal();
    const publish = vi.fn();
    const svc = build([
      stubPair(IEventService, {
        ...eventStub(),
        publish,
      }),
    ]);
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    const archived: string[] = [];
    const subscription = svc.onDidArchiveSession((event) => archived.push(event.sessionId));

    try {
      await Promise.all([svc.archive('s1'), svc.archive('s1')]);

      expect(svc.get('s1')).toBeUndefined();
      expect(disposedSessionScopes).toEqual(['s1']);
      expect(archived).toEqual(['s1']);
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      subscription.dispose();
    }
  });

  describe('additional dirs', () => {
    beforeEach(() => {
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
        ScopeActivation.OnDemand,
        'workspaceContext',
      );
    });

    function dirsOf(handle: { accessor: { get<T>(id: unknown): T } }): readonly string[] {
      return (handle.accessor.get(ISessionWorkspaceContext) as ISessionWorkspaceContext)
        .additionalDirs;
    }

    it('loads project-local additional dirs into the session workspace on create', async () => {
      const svc = build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
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
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/shared'])),
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
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/a', '/tmp/b'])),
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
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
        stubPair(IWorkspaceService, {
          ...workspaceStub(),
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
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
        stubPair(IWorkspaceService, {
          ...workspaceStub(),
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
        stubPair(IWorkspaceService, {
          ...workspaceStub(),
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
      return stubPair(IWorkspaceService, {
        ...workspaceStub(),
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
      const invalidate = vi.fn(() => Promise.resolve());
      const svc = build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        workspaceGetStub(),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          invalidate,
        }),
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
      expect(invalidate).toHaveBeenCalledWith('dst', 'wd_stub');
      await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toThrow(
        'not implemented',
      );
    });

    it('removes mirrored read-model metadata when fork cron startup rolls back', async () => {
      const root = await makeTmpRoot();
      const startupError = new Error('fork cron startup failed');
      let cronStarts = 0;
      const { svc, index, queryStore, bootstrap } = buildReadModel(root, [
        stubPair(ISessionCronService, {
          _serviceBrand: undefined,
          start: () => {
            cronStarts += 1;
            return cronStarts === 1 ? Promise.resolve() : Promise.reject(startupError);
          },
        } as unknown as ISessionCronService),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await expect(
        svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' }),
      ).rejects.toBe(startupError);

      expect(await queryStore.get('session', 'dst')).toBeUndefined();
      await expect(
        stat(bootstrap.sessionDir(encodeWorkDirKey('/tmp/proj'), 'dst')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await index.get('dst')).toBeUndefined();
      expect(svc.get('src')?.id).toBe('src');
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
        stubPair(IWorkspaceService, persistentWorkspaceStub()),
      ]);

      await svc.resume('s1');

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });
  });
});
