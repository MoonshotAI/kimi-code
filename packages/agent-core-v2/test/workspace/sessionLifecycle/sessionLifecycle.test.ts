import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { Hooks } from '#/hooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IEventService } from '#/app/event/event';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { IAgentPlanService } from '#/features/plan/plan';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionSubagentModelsValidationService } from '#/session/subagent/subagentModelsValidation';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { stubProviderService } from '../../app/provider/stubs';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import { WorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycleService';
import { resumeSessionById } from '#/app/workspaceLifecycle/sessionLookup';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';
import { WorkspaceToolPolicyService } from '#/workspace/workspaceToolPolicy/workspaceToolPolicyService';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import {
  ISessionMetadata,
  type SessionMetaPatch,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAppStateService } from '#/app/state/appState';
import { AppStateService } from '#/app/state/appStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { stubLog } from '../../_base/log/stubs';

function bootstrapStub(): IBootstrapService {
  return {
    homeDir: '/tmp',
    scope: (name: string) => name,
  } as unknown as IBootstrapService;
}

function tmpBootstrapStub(root: string): IBootstrapService {
  return {
    homeDir: root,
    scope: (name: string) => name,
  } as unknown as IBootstrapService;
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
    setGeneratedTitleIfUncustomized: () => Promise.resolve(false),
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
    onDidChange: () => ({ dispose: () => {} }),
    reload: () => Promise.resolve(),
    sessionData: () => ({
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      catalog,
      onDidChange: () => ({ dispose: () => {} }),
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

function agentProfileLoaderStubs(): ReturnType<typeof stubPair>[] {
  return [
    stubPair(IWorkspaceAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IExtraAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IExplicitAgentProfileLoader, agentProfileLoaderStub()),
    stubPair(IUserAgentProfileLoader, userAgentProfileLoaderStub()),
    stubPair(IPluginAgentProfileLoader, agentProfileLoaderStub()),
  ];
}

function workspaceInstructionsStub(): IWorkspaceInstructionsService {
  const provider = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    agentsMd: undefined,
    agentsMdWarning: undefined,
    onDidChange: () => ({ dispose: () => {} }),
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    snapshot: { agentsMd: undefined, agentsMdWarning: undefined },
    onDidChange: () => ({ dispose: () => {} }),
    reload: () => Promise.resolve(),
    sessionProvider: () => provider,
  } as unknown as IWorkspaceInstructionsService;
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

function sessionIndexMirrorStub(): ISessionIndexMirror {
  return {
    _serviceBrand: undefined,
    record: () => {},
    pending: () => [],
    evict: () => Promise.resolve(),
    drain: () => Promise.resolve(),
  };
}

function sessionIndexStub(): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: () => Promise.resolve({ state: 'uninitialized', degradedCount: 0 }),
    status: () => ({ state: 'uninitialized', degradedCount: 0 }),
    listRecent: () => Promise.resolve({ items: [] }),
    get: () => Promise.resolve(undefined),
    count: () => Promise.resolve(0),
    remove: () => Promise.resolve(),
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
    prepare: () => Promise.resolve({ state: 'uninitialized', degradedCount: 0 }),
    status: () => ({ state: 'uninitialized', degradedCount: 0 }),
    listRecent: () => Promise.resolve({ items: [summary] }),
    get: (id) => Promise.resolve(id === sessionId ? summary : undefined),
    count: () => Promise.resolve(1),
    remove: () => Promise.resolve(),
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

function workspaceMcpServiceStub(ready: Promise<void> = Promise.resolve()): IWorkspaceMcpService {
  return {
    _serviceBrand: undefined,
    ready,
    connectionManager: () => {
      throw new Error('not implemented');
    },
    sessionHandle: () => ({
      _serviceBrand: undefined,
      ready,
      get connectionManager(): McpConnectionManager {
        throw new Error('not implemented');
      },
      isBaselineServer: () => true,
    }),
    sessionOverlay: () => {
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

function modelCatalogStub(knownIds: readonly string[] = []): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (id: string) => {
      if (!knownIds.includes(id)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Model "${id}" is not configured in config.toml.`,
          { details: { model: id } },
        );
      }
      return { id };
    },
  } as unknown as IModelCatalog;
}

function modelServiceStub(ready: Promise<void> = Promise.resolve()): IModelService {
  return {
    _serviceBrand: undefined,
    ready,
  } as unknown as IModelService;
}

function secondaryModelFlagStub(enabled: boolean): IFlagService {
  return stubFlag((id) => enabled && id === SECONDARY_MODEL_FLAG_ID);
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

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionLifecycleHooks hooks: Hooks<SessionLifecycleHookSlots>,
  ) {
    super();
    this._register(
      hooks.onDidCreateSession.register('test', async (event, next) => {
        recordedSessionHookEvents.push(`create:${event.source}:${this.context.sessionId}`);
        await next();
      }),
    );
    this._register(
      hooks.onWillCloseSession.register('test', async (event, next) => {
        recordedSessionHookEvents.push(`close:${event.reason}:${this.context.sessionId}`);
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
      IWorkspaceLifecycleService,
      WorkspaceLifecycleService,
      ScopeActivation.OnDemand,
      'workspaceLifecycle',
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

  async function build(
    extra: ReturnType<typeof stubPair>[] = [],
  ): Promise<ISessionLifecycleService> {
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub()),
      stubPair(ISessionMetadata, metadataStub()),
      stubPair(IHostEnvironment, hostEnvironmentStub()),
      stubPair(IWorkspaceSkillCatalog, workspaceSkillCatalogStub()),
      stubPair(ISessionToolPolicy, sessionToolPolicyStub()),
      stubPair(ISessionProcessRunner, {
        _serviceBrand: undefined,
        exec: () => Promise.reject(new Error('process exec is not supported in this test')),
      } satisfies ISessionProcessRunner),
      ...agentProfileLoaderStubs(),
      stubPair(IWorkspaceInstructionsService, workspaceInstructionsStub()),
      stubPair(IWorkspaceService, workspaceStub()),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(ISessionIndexMirror, sessionIndexMirrorStub()),
      stubPair(IAppendLogStore, appendLogStoreStub()),
      stubPair(IAtomicDocumentStore, atomicDocumentStoreStub()),
      stubPair(IEventService, eventStub()),
      stubPair(IAgentLifecycleService, agentLifecycleStub()),
      stubPair(IWorkspaceMcpService, workspaceMcpServiceStub()),
      stubPair(IConfigService, configStub()),
      stubPair(IModelCatalog, modelCatalogStub()),
      stubPair(IModelService, modelServiceStub()),
      stubPair(IProviderService, stubProviderService()),
      stubPair(IFlagService, secondaryModelFlagStub(false)),
      stubPair(ISessionCronService, { _serviceBrand: undefined } as unknown as ISessionCronService),
      stubPair(ISessionSubagentModelsValidationService, {
        _serviceBrand: undefined,
      } as ISessionSubagentModelsValidationService),
      stubPair(IProjectLocalConfigService, projectLocalConfigStub()),
      stubPair(IHostFsWatchService, {
        _serviceBrand: undefined,
        watch: () => ({ onDidChange: Event.None, dispose: () => {} }),
      } as unknown as IHostFsWatchService),
      stubPair(ILogService, stubLog()),
      stubPair(ITelemetryService, recordingTelemetry(telemetryRecords)),
      stubPair(ICronTaskPersistence, cronStoreStub()),
      ...extra,
    ]);
    const lifecycle = host.app.accessor.get(IWorkspaceLifecycleService);
    const handler = await lifecycle.handlerFor({ root: '/tmp/proj' });
    return handler.accessor.get(ISessionLifecycleService);
  }

  async function makeTmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-fork-test-'));
    tmpRoots.push(root);
    return root;
  }

  it('create / get / list / close', async () => {
    const svc = await build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(h.id).toBe('s1');
    expect(svc.get('s1')).toBe(h);
    expect(svc.list()).toEqual([h]);

    await svc.close('s1');
    expect(svc.get('s1')).toBeUndefined();
  });

  it('create seeds identity and materializes metadata', async () => {
    const svc = await build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(h.kind).toBe(LifecycleScope.Session);
  });

  it('re-arms the explicit agent-profile loader after a fatal ready rejection so a later create succeeds', async () => {
    let readyAttempts = 0;
    const reload = vi.fn(() => Promise.resolve());
    const loaderStub = {
      ...agentProfileLoaderStub(),
      get ready(): Promise<void> {
        readyAttempts += 1;
        return readyAttempts === 1
          ? Promise.reject(new Error('fatal explicit file'))
          : Promise.resolve();
      },
      reload,
    } satisfies IExplicitAgentProfileLoader;
    const svc = await build([stubPair(IExplicitAgentProfileLoader, loaderStub)]);

    await expect(svc.create({ sessionId: 's1', workDir: '/tmp/proj' })).rejects.toThrow(
      'fatal explicit file',
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(svc.get('s1')).toBeUndefined();

    await svc.create({ sessionId: 's2', workDir: '/tmp/proj' });
    expect(svc.get('s2')).toBeDefined();
  });

  it('rejects create with CONFIG_INVALID for a broken subagent model pool before registering anything', async () => {
    const svc = await build([
      stubPair(
        IConfigService,
        configStub({ secondaryModel: { models: { 'provider/fast': 'fast and cheap' } } }),
      ),
      stubPair(IModelCatalog, modelCatalogStub(['provider/fast'])),
      stubPair(IFlagService, secondaryModelFlagStub(true)),
    ]);

    await expect(svc.create({ sessionId: 's-broken', workDir: '/tmp/proj' })).rejects.toMatchObject(
      {
        code: ErrorCodes.CONFIG_INVALID,
        message: expect.stringContaining('[secondary_model].default_model is required'),
      },
    );
    expect(svc.get('s-broken')).toBeUndefined();
  });

  it('creates a session when the subagent model pool is valid', async () => {
    const svc = await build([
      stubPair(
        IConfigService,
        configStub({
          secondaryModel: {
            defaultModel: 'provider/fast',
            models: { 'provider/fast': 'fast and cheap' },
          },
        }),
      ),
      stubPair(IModelCatalog, modelCatalogStub(['provider/fast'])),
      stubPair(IFlagService, secondaryModelFlagStub(true)),
    ]);

    const h = await svc.create({ sessionId: 's-pool', workDir: '/tmp/proj' });
    expect(svc.get('s-pool')).toBe(h);
  });

  it('waits for the model/provider registries before validating the subagent model pool', async () => {
    let releaseRegistries!: () => void;
    const registriesReady = new Promise<void>((resolve) => {
      releaseRegistries = resolve;
    });
    let registriesReleased = false;
    const coldRegistryCatalog = {
      _serviceBrand: undefined,
      get: (id: string) => {
        if (!registriesReleased) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `Model "${id}" is not configured in config.toml.`,
            { details: { model: id } },
          );
        }
        return { id };
      },
    } as unknown as IModelCatalog;
    const svc = await build([
      stubPair(
        IConfigService,
        configStub({
          secondaryModel: {
            defaultModel: 'provider/fast',
            models: { 'provider/fast': 'fast and cheap' },
          },
        }),
      ),
      stubPair(IModelCatalog, coldRegistryCatalog),
      stubPair(IModelService, modelServiceStub(registriesReady)),
      stubPair(IProviderService, stubProviderService({}, registriesReady)),
      stubPair(IFlagService, secondaryModelFlagStub(true)),
    ]);

    // A cold bootstrap can reach create before the kosong registries finish
    // hydrating: the pre-flight must hold, not fail the valid pool against an
    // empty registry.
    let settled = false;
    const pending = svc.create({ sessionId: 's-race', workDir: '/tmp/proj' }).then((created) => {
      settled = true;
      return created;
    });
    await tick();
    expect(settled).toBe(false);

    registriesReleased = true;
    releaseRegistries();
    const h = await pending;
    expect(svc.get('s-race')).toBe(h);
  });

  it('rejects create with CONFIG_INVALID when force is set without default_model', async () => {
    const svc = await build([
      stubPair(IConfigService, configStub({ secondaryModel: { force: true } })),
      stubPair(IModelCatalog, modelCatalogStub(['provider/fast'])),
      stubPair(IFlagService, secondaryModelFlagStub(true)),
    ]);

    await expect(svc.create({ sessionId: 's-force', workDir: '/tmp/proj' })).rejects.toMatchObject(
      {
        code: ErrorCodes.CONFIG_INVALID,
        message: expect.stringContaining('[secondary_model].default_model is required'),
      },
    );
    expect(svc.get('s-force')).toBeUndefined();
  });

  it('creates a session with a broken pool while the secondary-model experiment is off', async () => {
    const svc = await build([
      stubPair(
        IConfigService,
        configStub({ secondaryModel: { models: { 'provider/fast': 'fast and cheap' } } }),
      ),
      stubPair(IModelCatalog, modelCatalogStub(['provider/fast'])),
    ]);

    const h = await svc.create({ sessionId: 's-inert', workDir: '/tmp/proj' });
    expect(svc.get('s-inert')).toBe(h);
  });

  it('rejects fork with CONFIG_INVALID for a broken pool before copying any files', async () => {
    const root = await makeTmpRoot();
    const sections: Record<string, unknown> = {
      secondaryModel: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
      },
    };
    const svc = await build([
      stubPair(IBootstrapService, tmpBootstrapStub(root)),
      stubPair(IConfigService, {
        get: (domain: string) => sections[domain],
        getAll: () => ({ ...sections }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
        onDidSectionChange: () => ({ dispose: () => {} }),
      } as unknown as IConfigService),
      stubPair(IModelCatalog, modelCatalogStub(['provider/fast'])),
      stubPair(IFlagService, secondaryModelFlagStub(true)),
    ]);
    await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
    const srcDir = join(root, 'sessions', 'wd_stub', 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'marker'), 'src');
    sections['secondaryModel'] = { models: { 'provider/fast': 'fast and cheap' } };

    await expect(svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
    expect(svc.get('dst')).toBeUndefined();
    await expect(stat(join(root, 'sessions', 'wd_stub', 'dst'))).rejects.toThrow();
  });

  it('create appends the session to the shared session_index.jsonl', async () => {
    const appended: unknown[] = [];
    const svc = await build([
      stubPair(IAppendLogStore, {
        ...appendLogStoreStub(),
        append: (scope: string, key: string, record: unknown) => {
          appended.push({ scope, key, record });
        },
      }),
    ]);

    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

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
    const svc = await build([
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
    const svc = await build([
      stubPair(IAppendLogStore, {
        ...appendLogStoreStub(),
        append: (scope: string, key: string, record: unknown) => {
          appended.push({ scope, key, record });
        },
      }),
      stubPair(IWorkspaceService, {
        ...workspaceStub(),
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
    const first = await build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(ISessionIndex, sessionIndex),
    ]);

    await first.create({ sessionId: 's1', workDir });
    await expect(workspaces.get(encodeWorkDirKey(workDir))).resolves.toMatchObject({
      root: workDir,
    });
    host?.dispose();
    host = undefined;

    const second = await build([
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
    const svc = await build([
      stubPair(IWorkspaceService, persistentWorkspaceStub()),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await svc.resume('s1');

    expect(resumed?.id).toBe('s1');
    expect(resumed?.accessor.get(ISessionContext).workspaceId).toBe(encodeWorkDirKey(workDir));
  });

  it('does not cache a session whose tool policy fails to initialize', async () => {
    const svc = await build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_stub')),
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
    await build([
      stubPair(IWorkspaceService, workspaces),
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', workDir, indexedWorkspaceId)),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);

    const resumed = await resumeSessionById(host!.app.accessor, 's1');
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
    const svc = await build([
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
    const svc = await build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_stub')),
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

  it('restore re-creates the main agent for a cold empty session, then unarchives', async () => {
    // The registration itself is non-touching (pinned at the SessionMetadata
    // level), so restore only needs the plain unarchive write.
    const calls: string[] = [];
    const agentHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: () => {
          throw new Error('unexpected service access');
        },
      },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;
    const svc = await build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_stub')),
      stubPair(ISessionMetadata, {
        ...metadataStub(),
        setArchived: (value: boolean) => {
          calls.push(`setArchived:${value}`);
          return Promise.resolve();
        },
      }),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: async () => {
          calls.push('create');
          return agentHandle;
        },
      }),
    ]);

    const restored = await svc.restore('s1');

    expect(restored?.id).toBe('s1');
    expect(calls).toEqual(['create', 'setArchived:false']);
  });

  describe('delete', () => {
    function recordingAppendLogStore(appended: { key: string; record: unknown }[]): IAppendLogStore {
      return {
        ...appendLogStoreStub(),
        append: (_scope: string, key: string, record: unknown) => {
          appended.push({ key, record });
        },
      };
    }

    it('closes a live session, removes its directory, evicts the index, and appends the tombstone', async () => {
      const root = await makeTmpRoot();
      const appended: { key: string; record: unknown }[] = [];
      const removedFromIndex: string[] = [];
      const closed: string[] = [];
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        stubPair(IAppendLogStore, recordingAppendLogStore(appended)),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          remove: (id: string) => {
            removedFromIndex.push(id);
            return Promise.resolve();
          },
        }),
      ]);
      svc.onDidCloseSession((e) => closed.push(e.sessionId));

      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
      const sessionDir = join(root, 'sessions', 'wd_stub', 's1');
      await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
      await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), '{}\n');

      await svc.delete('s1');

      expect(svc.get('s1')).toBeUndefined();
      expect(closed).toEqual(['s1']);
      await expect(stat(sessionDir)).rejects.toThrow();
      expect(removedFromIndex).toEqual(['s1']);
      expect(appended).toContainEqual({
        key: 'session_index.jsonl',
        record: { sessionId: 's1', deleted: true },
      });
    });

    it('removes a persisted session that is not live', async () => {
      const root = await makeTmpRoot();
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
        stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_stub')),
      ]);
      const sessionDir = join(root, 'sessions', 'wd_stub', 's1');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'state.json'), '{}');

      await svc.delete('s1');

      expect(svc.get('s1')).toBeUndefined();
      await expect(stat(sessionDir)).rejects.toThrow();
    });

    it('throws session.not_found for an unknown id and appends no tombstone', async () => {
      const appended: { key: string; record: unknown }[] = [];
      const svc = await build([stubPair(IAppendLogStore, recordingAppendLogStore(appended))]);

      await expect(svc.delete('nope')).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
      expect(appended).toEqual([]);
    });

    it('throws session.not_found when deleting the same id twice', async () => {
      const svc = await build();
      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      await svc.delete('s1');
      await expect(svc.delete('s1')).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
    });

    it('throws session.not_found for a session persisted under another workspace', async () => {
      const svc = await build([
        stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_other')),
      ]);

      await expect(svc.delete('s1')).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
    });
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
    const svc = await build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        list: () => [busyAgent],
      }),
    ]);

    await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

    const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });
    expect(target.id).toBe('dst');
  });

  it('fires onDidCreateSession with the new handle', async () => {
    const svc = await build();
    let captured: { readonly sessionId: string } | undefined;
    svc.onDidCreateSession((e) => {
      captured = e;
    });
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(captured).toMatchObject({ sessionId: 's1', handle: h, source: 'startup' });
  });

  it('emits session_started with resumed: false and the bound session id on create', async () => {
    const svc = await build();
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(telemetryRecords).toContainEqual({
      event: 'session_started',
      properties: { sessionId: 's1', resumed: false },
    });
  });

  it('keeps telemetry session context isolated when multiple sessions emit interleaved events', async () => {
    const svc = await build();
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
    const svc = await build([
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
    const svc = await build([
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
    const svc = await build([
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
      ScopeActivation.OnScopeCreated,
      'externalHooks',
    );
    const svc = await build();

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.close('s1');

    expect(recordedSessionHookEvents).toEqual(['create:startup:s1', 'close:exit:s1']);
  });

  it('returns from create without waiting for MCP initialization', async () => {
    let resolveMcpReady: (() => void) | undefined;
    const mcpReady = new Promise<void>((resolve) => {
      resolveMcpReady = resolve;
    });
    const svc = await build([
      stubPair(IWorkspaceMcpService, workspaceMcpServiceStub(mcpReady)),
    ]);

    // Create resolves while the workspace MCP initial connect is still
    // pending; the seeded handle carries the readiness promise so the agent's
    // LLM steps can wait on it instead.
    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(handle.accessor.get(ISessionMcpHandle).ready).toBe(mcpReady);

    resolveMcpReady?.();
  });

  it('create with mcpServers fires the will-create event with the ephemeral servers seed and applies participant contributions', async () => {
    const mcpServers = { eph: { transport: 'stdio' as const, command: 'node' } };
    const contributed: ISessionMcpHandle = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      connectionManager: {} as unknown as McpConnectionManager,
      isBaselineServer: () => true,
    };
    const seen: Array<{
      sessionId: string;
      servers: Readonly<Record<string, McpServerConfig>>;
      cwd: string;
    }> = [];
    const svc = await build();
    svc.onWillCreateSession((event) => {
      const servers = event.readSeed(ISessionEphemeralMcpServers);
      const cwd = event.readSeed(ISessionContext).cwd;
      seen.push({ sessionId: event.sessionId, servers, cwd });
      if (Object.keys(servers).length > 0) {
        event.contributeSeed(ISessionMcpHandle, contributed);
      }
    });

    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj', mcpServers });

    expect(seen).toEqual([{ sessionId: 's1', servers: mcpServers, cwd: '/tmp/proj' }]);
    expect(handle.accessor.get(ISessionMcpHandle)).toBe(contributed);
  });

  it('resume with mcpServers fires the will-create event for the re-materialized session', async () => {
    const mcpServers = { eph: { transport: 'stdio' as const, command: 'node' } };
    const seen: Array<Readonly<Record<string, McpServerConfig>>> = [];
    const svc = await build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_stub')),
      stubPair(IAgentLifecycleService, agentLifecycleWithMainStub()),
    ]);
    svc.onWillCreateSession((event) => {
      seen.push(event.readSeed(ISessionEphemeralMcpServers));
    });

    const handle = await svc.resume('s1', { mcpServers });

    expect(handle).toBeDefined();
    expect(seen).toEqual([mcpServers]);
  });

  it('returns from create without waiting on a participant-provided session MCP handle', async () => {
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const contributed: ISessionMcpHandle = {
      _serviceBrand: undefined,
      ready,
      connectionManager: {} as unknown as McpConnectionManager,
      isBaselineServer: () => true,
    };
    const svc = await build();
    svc.onWillCreateSession((event) => {
      event.contributeSeed(ISessionMcpHandle, contributed);
    });

    // Create resolves while the contributed handle's readiness is still
    // pending; the seeded handle carries the readiness promise so the agent's
    // LLM steps can wait on it instead.
    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(handle.accessor.get(ISessionMcpHandle).ready).toBe(ready);

    resolveReady?.();
  });

  it('runs participant-attached teardown when create fails after materialization', async () => {
    const onTeardown = vi.fn();
    const svc = await build([
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => Promise.reject(new Error('Unknown agent profile')),
      }),
    ]);
    svc.onWillCreateSession((event) => {
      event.onSessionDispose(onTeardown);
    });

    await expect(
      svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        mainAgentBinding: { profile: 'missing', model: 'mock' },
      }),
    ).rejects.toThrow('Unknown agent profile');

    expect(onTeardown).toHaveBeenCalledTimes(1);
    expect(svc.get('s1')).toBeUndefined();
  });

  it('runs participant-attached teardown on close, exactly once across close and host disposal', async () => {
    const onTeardown = vi.fn();
    const svc = await build();
    svc.onWillCreateSession((event) => {
      event.onSessionDispose(onTeardown);
    });
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    await svc.close('s1');
    expect(onTeardown).toHaveBeenCalledTimes(1);

    // Host teardown disposes the workspace (and therefore session) container
    // directly; the attached teardown has already run and must not run again.
    host?.dispose();
    await Promise.resolve();
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('runs participant-attached teardown when the host is disposed with the session still live', async () => {
    const onTeardown = vi.fn();
    const svc = await build();
    svc.onWillCreateSession((event) => {
      event.onSessionDispose(onTeardown);
    });
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    // No close: app/workspace teardown disposes the session scope directly,
    // and the attached teardown runs with it.
    host?.dispose();
    await Promise.resolve();
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('create without mcpServers fires the will-create event with an empty ephemeral seed and keeps the workspace handle', async () => {
    const svc = await build();
    const seen: Array<Readonly<Record<string, McpServerConfig>>> = [];
    svc.onWillCreateSession((event) => {
      seen.push(event.readSeed(ISessionEphemeralMcpServers));
    });

    const handle = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

    expect(seen).toEqual([{}]);
    // No participant contributed a handle: the session reads the workspace
    // projection provided by the seed adapter.
    expect(handle.accessor.get(ISessionMcpHandle).isBaselineServer('any')).toBe(true);
    await svc.close('s1');
  });

  it('hides a session from get/list until its resume finishes', async () => {
    let releaseMainAgent: ((handle: IAgentScopeHandle) => void) | undefined;
    const mainAgent = new Promise<IAgentScopeHandle>((resolve) => {
      releaseMainAgent = resolve;
    });
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
    const svc = await build([
      stubPair(ISessionIndex, sessionIndexWithSummary('s1', '/tmp/proj', 'wd_stub')),
      stubPair(IAgentLifecycleService, {
        ...agentLifecycleStub(),
        create: () => mainAgent,
      }),
    ]);

    const resumed = svc.resume('s1');
    await tick();

    expect(svc.get('s1')).toBeUndefined();
    expect(svc.list()).toEqual([]);

    releaseMainAgent?.(main);
    const handle = await resumed;

    expect(handle?.id).toBe('s1');
    expect(svc.get('s1')).toBe(handle);
    expect(svc.list()).toEqual([handle]);
  });

  it('fires onDidCloseSession when a session is closed', async () => {
    const svc = await build();
    const closed: string[] = [];
    svc.onDidCloseSession((e) => closed.push(e.sessionId));
    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.close('s1');
    expect(closed).toEqual(['s1']);
  });

  it('fires onDidArchiveSession when a session is archived', async () => {
    const svc = await build([
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
      const svc = await build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
      ]);
      const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
      expect(dirsOf(h)).toEqual(['/tmp/extra']);
    });

    it('merges caller additionalDirs and resolves relative paths against workDir', async () => {
      const svc = await build();
      const h = await svc.create({
        sessionId: 's1',
        workDir: '/tmp/proj',
        additionalDirs: ['../sibling', '/abs/dir'],
      });
      expect(dirsOf(h)).toEqual(['/tmp/sibling', '/abs/dir']);
    });

    it('deduplicates project-local and caller dirs after resolving', async () => {
      const svc = await build([
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
      const svc = await build([
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
      const svc = await build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
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
      const svc = await build([
        stubPair(IProjectLocalConfigService, projectLocalConfigStub(['/tmp/extra'])),
      ]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const target = await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(dirsOf(target)).toEqual(['/tmp/extra']);
    });

    it('create mints a session_-prefixed lowercase id when none is supplied', async () => {
      const svc = await build();
      const h = await svc.create({ workDir: '/tmp/proj' });

      expect(h.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(h.id).toBe(h.id.toLowerCase());
      expect(svc.get(h.id)).toBe(h);
    });

    it('fork mints a session_-prefixed lowercase id when newSessionId is omitted', async () => {
      const svc = await build();

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      const target = await svc.fork({ sourceSessionId: 'src' });

      expect(target.id).toMatch(/^session_[0-9a-f-]{36}$/);
      expect(target.id).toBe(target.id.toLowerCase());
      expect(target.id).not.toBe('src');
    });
  });

  describe('fork session state', () => {
    it('marks the default fork title as replaceable', async () => {
      const updates: SessionMetaPatch[] = [];
      const svc = await build([
        stubPair(ISessionMetadata, {
          ...metadataStub(),
          read: () =>
            Promise.resolve({
              title: 'generated source',
              titleKind: 'generated',
              agents: {},
            } as never),
          update: (patch) => {
            updates.push(patch);
            return Promise.resolve();
          },
        }),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(updates).toContainEqual(
        expect.objectContaining({ title: 'Fork: generated source', titleKind: 'replaceable' }),
      );
    });

    it('marks an explicit fork title as custom', async () => {
      const updates: SessionMetaPatch[] = [];
      const svc = await build([
        stubPair(ISessionMetadata, {
          ...metadataStub(),
          read: () => Promise.resolve({ title: 'source', agents: {} } as never),
          update: (patch) => {
            updates.push(patch);
            return Promise.resolve();
          },
        }),
      ]);
      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });

      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst', title: 'user title' });

      expect(updates).toContainEqual(
        expect.objectContaining({ title: 'user title', titleKind: 'custom' }),
      );
    });

    it('fork inherits the source session\'s last turn outcome', async () => {
      const updates: { readonly lastTurnReason?: unknown }[] = [];
      const metaStub: ISessionMetadata = {
        ...metadataStub(),
        read: () =>
          Promise.resolve({ lastTurnReason: 'failed', agents: {} } as never),
        update: (patch) => {
          updates.push(patch);
          return Promise.resolve();
        },
      };
      const svc = await build([stubPair(ISessionMetadata, metaStub)]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      const forkUpdate = updates.find((u) => 'forkedFrom' in u);
      expect(forkUpdate?.lastTurnReason).toBe('failed');
    });

    it('fork inherits the source session\'s updatedAt (a copy is not fresh activity)', async () => {
      const updates: { readonly updatedAt?: unknown }[] = [];
      const metaStub: ISessionMetadata = {
        ...metadataStub(),
        read: () =>
          Promise.resolve({ updatedAt: 9876, agents: {} } as never),
        update: (patch) => {
          updates.push(patch);
          return Promise.resolve();
        },
      };
      const svc = await build([stubPair(ISessionMetadata, metaStub)]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      const forkUpdate = updates.find((u) => 'forkedFrom' in u);
      expect(forkUpdate?.updatedAt).toBe(9876);
    });

    it('fork normalizes a legacy ISO-string updatedAt from a cold source to epoch ms', async () => {
      const updates: { readonly updatedAt?: unknown }[] = [];
      const metaStub: ISessionMetadata = {
        ...metadataStub(),
        // A cold legacy/v1 document read from disk can still carry an ISO
        // string — the fork must not persist it as the v2 updatedAt.
        read: () =>
          Promise.resolve({ updatedAt: '2026-08-10T23:00:00.000Z', agents: {} } as never),
        update: (patch) => {
          updates.push(patch);
          return Promise.resolve();
        },
      };
      const svc = await build([stubPair(ISessionMetadata, metaStub)]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      const forkUpdate = updates.find((u) => 'forkedFrom' in u);
      expect(forkUpdate?.updatedAt).toBe(Date.parse('2026-08-10T23:00:00.000Z'));
    });

    it('fork writes the inherited updatedAt AFTER agent registration (registering bumps it)', async () => {
      const calls: string[] = [];
      const metaStub: ISessionMetadata = {
        ...metadataStub(),
        read: () =>
          Promise.resolve({
            updatedAt: 9876,
            agents: { main: { type: 'main', homedir: '/tmp/h' } },
          } as never),
        update: (patch) => {
          calls.push('forkedFrom' in patch ? 'update:fork' : 'update:other');
          return Promise.resolve();
        },
        registerAgent: () => {
          calls.push('registerAgent');
          return Promise.resolve();
        },
      };
      const agentHandle = {
        id: 'main',
        kind: LifecycleScope.Agent,
        accessor: {
          get: () => {
            throw new Error('unexpected service access');
          },
        },
        dispose: () => {},
      } as unknown as IAgentScopeHandle;
      const svc = await build([
        stubPair(ISessionMetadata, metaStub),
        stubPair(IAgentLifecycleService, {
          ...agentLifecycleStub(),
          create: async () => {
            // Mirror the real doCreate: recreation registers the agent, which
            // is an ordinary metadata write (it bumps updatedAt).
            await metaStub.registerAgent('main', {});
            return agentHandle;
          },
        }),
      ]);

      await svc.create({ sessionId: 'src', workDir: '/tmp/proj' });
      await svc.fork({ sourceSessionId: 'src', newSessionId: 'dst' });

      expect(calls).toContain('registerAgent');
      expect(calls.indexOf('update:fork')).toBeGreaterThan(calls.lastIndexOf('registerAgent'));
    });

    it('copies blobs, plans, background tasks, and media originals into the fork', async () => {
      const root = await makeTmpRoot();
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
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
      const svc = await build([
        stubPair(IBootstrapService, bootstrap),
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
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
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
      const svc = await build([
        stubPair(IBootstrapService, tmpBootstrapStub(root)),
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
      const svc = await build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
      ]);

      await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });

      expect(create).toHaveBeenCalledTimes(1);
      expect(enter).toHaveBeenCalledTimes(1);
    });

    it('leaves plan mode inactive when config.defaultPlanMode is absent', async () => {
      const { lifecycle, enter, create } = agentLifecycleCapturingPlanSpy();
      const svc = await build([
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
      const svc = await build([
        stubPair(IConfigService, configStub({ defaultPlanMode: true })),
        stubPair(IAgentLifecycleService, lifecycle),
        stubPair(ISessionIndex, {
          ...sessionIndexStub(),
          get: () => Promise.resolve(summary),
        }),
      ]);

      await svc.resume('s1');

      expect(create).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    });
  });
});
