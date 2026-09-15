import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { ScopeUnits, type Fiber } from '#/_base/di/fiber';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { userCancellationReason } from '#/_base/utils/abort';
import '#/agent/profile/profileService';
import { Emitter, Event } from '#/_base/event';
import { Ledger } from '#/_base/lifecycle/ledger';
import '#/agent/permissionMode/permissionModeService';
import { ILogService } from '#/_base/log/log';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import '#/agent/contextMemory/contextMemoryService';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type LoopSnapshot } from '#/agent/loop/loop';
import type { MachineEngine, MachineEngineAttachBundle } from '#/agent/loop/machine/engine';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
} from '#/agent/permissionMode/permissionModeOps';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { _clearAgentToolContributionsForTests } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import '#/agent/mcp/mcpService';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import '#/state/eventDispatcherService';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import { createMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { IPluginService } from '#/app/plugin/plugin';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionNotify } from '#/features/notify/sessionNotify';
import { AgentReminderService, IAgentReminderService } from '#/features/reminder/reminderService';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { SubagentSuspended } from '#/features/swarm/session/sessionSwarmService';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { IHostClock } from '#/os/interface/hostClock';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { createAgentAwaitingClose } from '#/session/agentLifecycle/createAwaitingClose';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import '#/agent/toolActivation/toolActivationService';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import {
  SubagentCancelled,
  SubagentCompleted,
  SubagentStarted,
} from '#/session/subagent/mirrorAgentRun';
import {
  DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE,
  DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS,
  ISessionSubagentScopeCacheService,
  resolveSubagentScopeCacheSize,
  resolveSubagentScopeEvictTimeoutMs,
  SUBAGENT_SCOPE_CACHE_SIZE_ENV,
  SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV,
} from '#/session/subagent/subagentScopeCache';
import { SessionSubagentScopeCacheService } from '#/session/subagent/subagentScopeCacheService';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { AgentEventStore } from '#human/agent/slices';

import { stubAgentContext } from '../../agent/agentContext/stubs';

const noopLog = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: async () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as ILogService;

interface RecordedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: unknown;
}

function recordingLog(): { readonly entries: RecordedLogEntry[]; readonly log: ILogService } {
  const entries: RecordedLogEntry[] = [];
  const record =
    (level: RecordedLogEntry['level']) =>
    (message: string, payload?: unknown): void => {
      entries.push({ level, message, payload });
    };
  const log = {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    flush: async () => {},
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    child: () => log,
  } as unknown as ILogService;
  return { entries, log };
}

const pluginServiceStub = {
  _serviceBrand: undefined,
  onDidReload: () => ({ dispose: () => {} }),
  listPlugins: async () => [],
  installPlugin: async () => ({ id: '' }) as never,
  setPluginEnabled: async () => {},
  setPluginMcpServerEnabled: async () => {},
  removePlugin: async () => {},
  reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
  getPluginInfo: async () => {
    throw new Error('getPluginInfo is not used by these tests');
  },
  listPluginCommands: async () => [],
  checkUpdates: async () => [],
  pluginSkillRoots: async () => [],
  enabledSessionStarts: async () => [],
  enabledMcpServers: async () => ({}),
  enabledHooks: async () => [],
} as unknown as IPluginService;

function stubAttachStore(): AgentEventStore {
  return {
    ref: { tree: 'test', branch: 'main' },
    getState: () => ({
      history: [],
      queue: [],
      notifications: [],
      reminders: [],
      turnIndex: { nextTurnId: 0 },
    }),
    subscribe: () => () => {},
    dispatch: () => Promise.resolve({ kind: 'entry', seq: 0, ts: 0, type: 'noop', payload: null }),
    registerSlice: () => Promise.resolve(() => {}),
    reset: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  } as unknown as AgentEventStore;
}

function stubAttachEngine(): MachineEngine {
  return {
    submit: () => {},
    steer: () => {},
    notify: () => {},
    remind: () => {},
    cancelQueueItem: () => {},
    abort: () => {},
    pause: () => {},
    resume: () => {},
    resetHistory: () => Promise.resolve(),
    resetJournal: () => Promise.resolve(),
    stop: () => {},
    snapshot: () => ({
      running: false,
      aborting: false,
      waitingForBackground: false,
      paused: false,
      queue: [],
      queueLength: 0,
      queueIds: [],
      notificationCount: 0,
      reminderCount: 0,
      backgroundCount: 0,
    }),
    currentStep: () => 0,
    lastFinish: () => undefined,
    toolExtras: new Map(),
    handleToolProgress: () => {},
  };
}

function stubAttachBundle(): MachineEngineAttachBundle {
  return {
    store: stubAttachStore(),
    request: { model: { provider: 'test', model: 'test' } },
  } as unknown as MachineEngineAttachBundle;
}

interface SessionActorView {
  getSnapshot(): {
    children: Record<string, { getSnapshot(): { status: string } } | undefined>;
    context: { agents: Record<string, unknown> };
  };
}

function recordingAppendLog(initial: readonly WireRecord[] = []): {
  readonly appended: WireRecord[];
  readonly store: IAppendLogStore;
  readonly flushAll: ReturnType<typeof vi.fn>;
  readonly flushLog: ReturnType<typeof vi.fn>;
  rewritten?: readonly WireRecord[];
} {
  const records = [...initial];
  const appended: WireRecord[] = [];
  const state: { rewritten?: readonly WireRecord[] } = {};
  const store: IAppendLogStore = {
    _serviceBrand: undefined,
    onDidWrite: Event.None as IAppendLogStore['onDidWrite'],
    append: <R>(_scope: string, _key: string, record: R) => {
      const persisted = record as unknown as WireRecord;
      records.push(persisted);
      appended.push(persisted);
    },
    read: async function* <R>(): AsyncIterable<R> {
      for (const record of records) {
        yield record as R;
      }
    },
    rewrite: <R>(_scope: string, _key: string, next: readonly R[]) => {
      const persisted = next as readonly WireRecord[];
      state.rewritten = persisted;
      records.splice(0, records.length, ...persisted);
      return Promise.resolve();
    },
    flush: vi.fn(() => Promise.resolve()),
    flushLog: vi.fn((_scope: string, _key: string) => Promise.resolve()),
    close: () => Promise.resolve(),
    acquire: () => ({ dispose: () => {} }),
    drainRetirements: () => Promise.resolve(),
  };
  return {
    appended,
    get rewritten() {
      return state.rewritten;
    },
    store,
    flushAll: store.flush as ReturnType<typeof vi.fn>,
    flushLog: store.flushLog as ReturnType<typeof vi.fn>,
  };
}

describe('resolveSubagentScopeCacheSize', () => {
  it('returns the default when the variable is unset, empty, or whitespace-only', () => {
    expect(resolveSubagentScopeCacheSize({})).toBe(DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE);
    expect(resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: '' })).toBe(
      DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE,
    );
    expect(resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: '   ' })).toBe(
      DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE,
    );
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: '5' })).toBe(5);
    expect(resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: ' 8 ' })).toBe(8);
  });

  it('returns zero for zero or negative values, disabling eviction', () => {
    expect(resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: '0' })).toBe(0);
    expect(resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: '-3' })).toBe(0);
  });

  it('throws for non-integer or non-numeric values', () => {
    for (const raw of ['2.5', 'abc']) {
      expect(() => resolveSubagentScopeCacheSize({ [SUBAGENT_SCOPE_CACHE_SIZE_ENV]: raw })).toThrow(
        /KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE.*integer/,
      );
    }
  });
});

describe('resolveSubagentScopeEvictTimeoutMs', () => {
  it('returns the default when the variable is unset, empty, or whitespace-only', () => {
    expect(resolveSubagentScopeEvictTimeoutMs({})).toBe(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS);
    expect(resolveSubagentScopeEvictTimeoutMs({ [SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV]: '' })).toBe(
      DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS,
    );
    expect(resolveSubagentScopeEvictTimeoutMs({ [SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV]: '   ' })).toBe(
      DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS,
    );
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSubagentScopeEvictTimeoutMs({ [SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV]: '250' })).toBe(
      250,
    );
  });

  it('throws for non-integer, non-numeric, or non-positive values', () => {
    for (const raw of ['2.5', 'abc', '0', '-10']) {
      expect(() =>
        resolveSubagentScopeEvictTimeoutMs({ [SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV]: raw }),
      ).toThrow(/KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS.*positive integer/);
    }
  });
});

describe('SessionSubagentScopeCacheService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let appendLog: ReturnType<typeof recordingAppendLog>;

  beforeEach(() => {
    _clearAgentToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(ISessionEventBus, new SyncDescriptor(EventBusService));
    ix.get(IAgentStateService).contributeState(permissionModeKey);
    ix.get(IAgentStateService).contributeState(permissionModeConfiguredKey);
    appendLog = recordingAppendLog();
    ix.stub(IAppendLogStore, appendLog.store);
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.stub(IBlobStore, new BlobStoreService(new InMemoryStorageService()));
    ix.set(ISessionMediaStore, new SyncDescriptor(SessionMediaStoreService));
    const atomicDocs = new Map<string, unknown>();
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-subagentScopeCache-test',
      metaScope: 'test',
      scope: (subKey?: string) =>
        subKey === undefined || subKey === ''
          ? 'sessions/ws_test/sess_test'
          : `sessions/ws_test/sess_test/${subKey}`,
    } as unknown as ISessionContext);
    ix.stub(IRuntimeResolver, {
      _serviceBrand: undefined,
      inspect: (binding) => new FakeRuntime({ ...binding, generation: `${binding.runtimeId}-one` }),
      acquire: (binding) => ({
        runtime: new FakeRuntime({ ...binding, generation: `${binding.runtimeId}-one` }),
        track: (resource) => resource,
        dispose: () => {},
      }),
    });
    ix.stub(IWorkspaceInstanceManager, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      get: () => undefined,
    });
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () => Promise.resolve({ id: 'sess_test', createdAt: 0, updatedAt: 0, archived: false }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent: () => Promise.resolve(),
    });
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/tmp/kimi-subagentScopeCache-home',
      cwd: '/tmp/kimi-subagentScopeCache-home',
      getEnv: () => undefined,
    } as unknown as IBootstrapService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: () => false,
    } as unknown as IFlagService);
    ix.stub(ISessionNotify, { _serviceBrand: undefined, ready: Promise.resolve(), enabled: false });
    ix.stub(ISessionWorkspaceContext, {
      _serviceBrand: undefined,
      workDir: '/tmp/kimi-subagentScopeCache-work',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext);
    ix.stub(IPluginService, pluginServiceStub);
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => undefined) as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);
    const atomicDocsStore: IAtomicDocumentStore = {
      _serviceBrand: undefined,
      get: async <T>(scope: string, key: string): Promise<T | undefined> =>
        atomicDocs.get(`${scope}/${key}`) as T | undefined,
      set: async <T>(scope: string, key: string, value: T): Promise<void> => {
        atomicDocs.set(`${scope}/${key}`, value);
      },
      delete: async (scope: string, key: string): Promise<void> => {
        atomicDocs.delete(`${scope}/${key}`);
      },
      list: async (scope: string, prefix = ''): Promise<readonly string[]> =>
        [...atomicDocs.keys()]
          .filter((key) => key.startsWith(`${scope}/${prefix}`))
          .map((key) => key.slice(scope.length + 1)),
      acquire: () => ({ dispose: () => {} }),
    };
    ix.stub(IAtomicDocumentStore, atomicDocsStore);
    ix.stub(ILogService, noopLog);
    ix.stub(IAgentPluginService, {
      _serviceBrand: undefined,
      refreshSessionStart: async () => {},
    });
    ix.stub(IAgentToolRegistryService, {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      resolve: () => undefined,
      list: () => [],
    } as unknown as IAgentToolRegistryService);
    ix.stub(IAgentMediaToolsRegistrar, {
      _serviceBrand: undefined,
    } as IAgentMediaToolsRegistrar);
    ix.stub(IAgentToolExecutorService, {
      _serviceBrand: undefined,
      onBeforeExecuteTool: () => ({ dispose: () => {} }),
      onWillExecuteTool: () => ({ dispose: () => {} }),
      hooks: {
        onDidExecuteTool: {
          register: () => ({ dispose: () => {} }),
        },
      },
    } as unknown as IAgentToolExecutorService);
    ix.stub(IAgentLoopService, {
      _serviceBrand: undefined,
      hooks: {
        onWillBeginStep: { register: () => ({ dispose: () => {} }) },
        onDidFinishStep: { register: () => ({ dispose: () => {} }) },
      },
      registerLoopErrorHandler: () => ({ dispose: () => {} }),
      snapshot: () => ({
        state: 'idle',
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: false,
      }),
      cancel: () => true,
      settled: async () => {},
      tryAcquireQuiescence: () => ({ dispose: () => {} }),
      buildAttachBundle: () => stubAttachBundle(),
      attachEngine: () => stubAttachEngine(),
    } as unknown as IAgentLoopService);
    ix.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track2: () => {},
      withContext: () =>
        ({
          _serviceBrand: undefined,
          track2: () => {},
        }) as unknown as ITelemetryService,
    } as unknown as ITelemetryService);
    ix.stub(IHostEnvironment, { _serviceBrand: undefined } as IHostEnvironment);
    ix.stub(IHostFileSystem, { _serviceBrand: undefined } as IHostFileSystem);
    ix.stub(IHostClock, { _serviceBrand: undefined } as IHostClock);
    ix.stub(IModelCatalog, { _serviceBrand: undefined } as IModelCatalog);
    ix.stub(ISessionTokenCountingService, {
      estimateText: () => 0,
      estimateMessage: () => 0,
      estimateMessages: () => 0,
      recordTruncation: () => {},
    } as unknown as ISessionTokenCountingService);
    ix.stub(IProtocolAdapterRegistry, {
      _serviceBrand: undefined,
    } as IProtocolAdapterRegistry);
    ix.stub(IBuiltinAgentProfileLoader, {
      _serviceBrand: undefined,
    } as IBuiltinAgentProfileLoader);
    ix.stub(IAgentIdentity, { _serviceBrand: undefined } as IAgentIdentity);
    ix.stub(IAgentAgentsMdReminderService, {
      _serviceBrand: undefined,
    } as IAgentAgentsMdReminderService);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => {
        throw new Error('catalog resolution is not expected');
      },
      list: () => [],
      load: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      onDidChange: Event.None,
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: { skills: [] },
      ready: Promise.resolve(),
      onDidChange: Event.None,
      load: () => Promise.resolve(),
      reload: () => Promise.resolve(),
    } as unknown as ISessionSkillCatalog);
    ix.stub(ISessionToolPolicy, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      disabledTools: () => [],
      setDisabledTools: () => Promise.resolve(),
    } as unknown as ISessionToolPolicy);
    ix.stub(ISessionToolPolicyGate, {
      _serviceBrand: undefined,
      disabledTools: [],
      onDidChange: Event.None as Event<void>,
    } satisfies ISessionToolPolicyGate);
    ix.stub(IAgentPermissionModeService, {
      _serviceBrand: undefined,
      mode: 'manual',
      setMode: () => {},
      onDidChangeMode: Event.None,
    } as unknown as IAgentPermissionModeService);
    ix.stub(ISessionInstructionsProvider, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      agentsMd: undefined,
      agentsMdWarning: undefined,
      agentsMdPaths: undefined,
      onDidChange: Event.None as ISessionInstructionsProvider['onDidChange'],
    } satisfies ISessionInstructionsProvider);
    ix.stub(IAgentAgentsMdReminderService, {
      _serviceBrand: undefined,
      seedInjected: () => {},
    });
    ix.stub(ISessionMcpHandle, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      connectionManager: new McpConnectionManager({
        log: noopLog,
        oauthService: new McpOAuthService({ store: createMcpOAuthStore(atomicDocsStore) }),
      }),
      isBaselineServer: () => true,
    } satisfies ISessionMcpHandle);
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      list: () => [],
      stopAllOnExit: async () => [],
      suppressAllTerminalNotifications: async () => {},
    } as unknown as IAgentTaskService);
    ix.stub(IAgentFullCompactionService, {
      _serviceBrand: undefined,
      compacting: null,
    } as unknown as IAgentFullCompactionService);
    ix.fiberHost.addCollectionRecord(
      ScopeUnits(LifecycleScope.Agent),
      'test-reminder',
      new Ledger('test-reminder'),
      {
        name: 'test:agentReminderService',
        apply(fiber: Fiber): void {
          fiber.provide(IAgentReminderService, AgentReminderService);
        },
      },
    );
    ix.set(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService));
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function cacheService(capacity: string): ISessionSubagentScopeCacheService {
    vi.stubEnv(SUBAGENT_SCOPE_CACHE_SIZE_ENV, capacity);
    ix.set(ISessionSubagentScopeCacheService, new SyncDescriptor(SessionSubagentScopeCacheService));
    return ix.get(ISessionSubagentScopeCacheService);
  }

  function bus(): ISessionEventBus {
    return ix.get(ISessionEventBus);
  }

  function completed(agentId: string): void {
    bus().publish(new SubagentCompleted({ subagentId: agentId, resultSummary: 'done' }));
  }

  function cancelled(agentId: string): void {
    bus().publish(new SubagentCancelled({ subagentId: agentId }));
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('evicts the oldest completed subagent scopes once the cache overflows', async () => {
    cacheService('2');
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    for (const agentId of ['agent-1', 'agent-2', 'agent-3']) {
      await svc.create({ agentId });
    }

    completed('agent-1');
    completed('agent-2');
    await settle();
    expect(svc.handleOf('agent-1')).toBeDefined();

    completed('agent-3');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });
    expect(svc.get('agent-1')).toBeUndefined();
    expect(svc.handleOf('agent-2')).toBeDefined();
    expect(svc.handleOf('agent-3')).toBeDefined();
    expect(svc.handleOf('main')).toBeDefined();
  });

  it('keeps completed subagent scopes live while within capacity', async () => {
    cacheService('2');
    const svc = ix.get(IAgentLifecycleService);
    for (const agentId of ['agent-1', 'agent-2']) {
      await svc.create({ agentId });
    }

    completed('agent-1');
    completed('agent-2');
    await settle();

    expect(svc.handleOf('agent-1')).toBeDefined();
    expect(svc.handleOf('agent-2')).toBeDefined();
  });

  it('defers eviction while the scope has active background tasks', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      list: (activeOnly?: boolean) => (activeOnly === true ? [{ taskId: 'task-1' }] : []),
      stopAllOnExit: async () => [],
      suppressAllTerminalNotifications: async () => {},
    } as unknown as IAgentTaskService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });

    completed('agent-1');
    completed('agent-2');
    await settle();

    expect(svc.handleOf('agent-1')).toBeDefined();
    expect(svc.handleOf('agent-2')).toBeDefined();
  });

  it('retires a cancelled subagent scope and evicts it once over capacity', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    for (const agentId of ['agent-1', 'agent-2']) {
      await svc.create({ agentId });
    }

    cancelled('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });
    expect(svc.handleOf('agent-2')).toBeDefined();
  });

  it('does not evict a suspended subagent', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    for (const agentId of ['agent-1', 'agent-2', 'agent-3']) {
      await svc.create({ agentId });
    }

    completed('agent-1');
    bus().publish(
      new SubagentSuspended({ subagentId: 'agent-1', reason: 'Provider rate limit; requeued.' }),
    );
    completed('agent-2');
    await settle();
    expect(svc.handleOf('agent-1')).toBeDefined();
    expect(svc.handleOf('agent-2')).toBeDefined();

    completed('agent-3');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-2')).toBeUndefined();
    });
    expect(svc.handleOf('agent-1')).toBeDefined();
    expect(svc.handleOf('agent-3')).toBeDefined();
  });

  it('evicts a suspended subagent once it is cancelled and the cache overflows', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    for (const agentId of ['agent-1', 'agent-2']) {
      await svc.create({ agentId });
    }

    bus().publish(
      new SubagentSuspended({ subagentId: 'agent-1', reason: 'Provider rate limit; requeued.' }),
    );
    cancelled('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });
    expect(svc.handleOf('agent-2')).toBeDefined();
  });

  it('never evicts when the cache size is zero', async () => {
    cacheService('0');
    const svc = ix.get(IAgentLifecycleService);
    for (const agentId of ['agent-1', 'agent-2', 'agent-3']) {
      await svc.create({ agentId });
    }

    completed('agent-1');
    completed('agent-2');
    completed('agent-3');
    await settle();

    expect(svc.handleOf('agent-1')).toBeDefined();
    expect(svc.handleOf('agent-2')).toBeDefined();
    expect(svc.handleOf('agent-3')).toBeDefined();
  });

  it('evicted scopes can be rebuilt on demand from persisted state', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });

    completed('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });

    const rebuilt = await svc.create({ agentId: 'agent-1' });
    expect(rebuilt.agentId).toBe('agent-1');
    expect(svc.handleOf('agent-1')).toBeDefined();
  });

  it('rebuild waits out an in-flight eviction remove and recreates the scope', async () => {
    vi.stubEnv(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV, '50');
    cacheService('1');
    const stopAll = createControlledPromise<never[]>();
    let stopAllCalls = 0;
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      list: () => [],
      stopAllOnExit: () => (stopAllCalls++ === 0 ? stopAll : Promise.resolve([])),
      suppressAllTerminalNotifications: async () => {},
    } as unknown as IAgentTaskService);
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });

    completed('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-2')).toBeUndefined();
    });

    await expect(svc.create({ agentId: 'agent-1' })).rejects.toThrow(/already exists/);

    const rebuilt = createAgentAwaitingClose(svc, { agentId: 'agent-1' });
    stopAll.resolve([]);
    await expect(rebuilt).resolves.toMatchObject({ agentId: 'agent-1' });
    expect(svc.handleOf('agent-1')).toBeDefined();
  });

  it('rebuild gives up waiting once the configured eviction timeout elapses', async () => {
    vi.stubEnv(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV, '50');
    cacheService('1');
    const stopAll = createControlledPromise<never[]>();
    let stopAllCalls = 0;
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      list: () => [],
      stopAllOnExit: () => (stopAllCalls++ === 0 ? stopAll : Promise.resolve([])),
      suppressAllTerminalNotifications: async () => {},
    } as unknown as IAgentTaskService);
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });

    completed('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-2')).toBeUndefined();
    });

    const started = Date.now();
    await expect(createAgentAwaitingClose(svc, { agentId: 'agent-1' })).rejects.toThrow(
      /already exists/,
    );
    expect(Date.now() - started).toBeLessThan(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS);
  });

  it('rebuild stops waiting when the caller aborts while the previous scope is still closing', async () => {
    vi.stubEnv(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV, '2000');
    cacheService('1');
    const stopAll = createControlledPromise<never[]>();
    let stopAllCalls = 0;
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      list: () => [],
      stopAllOnExit: () => (stopAllCalls++ === 0 ? stopAll : Promise.resolve([])),
      suppressAllTerminalNotifications: async () => {},
    } as unknown as IAgentTaskService);
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });

    completed('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });

    const controller = new AbortController();
    const rebuilt = createAgentAwaitingClose(svc, { agentId: 'agent-1' }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reason = userCancellationReason();
    controller.abort(reason);
    stopAll.resolve([]);
    await expect(rebuilt).rejects.toBe(reason);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(svc.handleOf('agent-1')).toBeUndefined();
  });

  it('flush during eviction touches only the evicted agent scope log', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });

    completed('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });

    expect(appendLog.flushAll).not.toHaveBeenCalled();
    expect(appendLog.flushLog).toHaveBeenCalledWith(
      'sessions/ws_test/sess_test/agents/agent-1',
      AGENT_WIRE_RECORD_KEY,
    );
  });

  it('eviction releases the evicted agent actor from the session machine', async () => {
    cacheService('1');
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'agent-1' });
    await svc.create({ agentId: 'agent-2' });
    const sessionActor = (svc as unknown as { sessionActor: SessionActorView }).sessionActor;
    const evictedRef = sessionActor.getSnapshot().children['agent-1'];
    expect(evictedRef).toBeDefined();

    completed('agent-1');
    completed('agent-2');
    await vi.waitFor(() => {
      expect(svc.handleOf('agent-1')).toBeUndefined();
    });

    const snapshot = sessionActor.getSnapshot();
    expect(snapshot.context.agents['agent-1']).toBeUndefined();
    expect(snapshot.children['agent-1']).toBeUndefined();
    expect(snapshot.children['agent-2']).toBeDefined();
    expect(evictedRef?.getSnapshot().status).toBe('done');
  });
});

describe('SessionSubagentScopeCacheService eviction guards', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let handles: Map<string, IAgentScopeHandle>;
  let closingAgents: Set<string>;
  let willClose: Emitter<AgentContext>;
  let didClose: Emitter<AgentContext>;
  let removeAgent: Mock<(context: AgentContext) => Promise<void>>;
  let bus: EventBusService;
  let logs: ReturnType<typeof recordingLog>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    handles = new Map();
    closingAgents = new Set();
    willClose = disposables.add(new Emitter<AgentContext>());
    didClose = disposables.add(new Emitter<AgentContext>());
    bus = disposables.add(new EventBusService());
    logs = recordingLog();
    removeAgent = vi.fn(async (context: AgentContext) => {
      closingAgents.add(context.agentId);
      willClose.fire(context);
      handles.delete(context.agentId);
      closingAgents.delete(context.agentId);
      didClose.fire(context);
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: Event.None,
      onDidCreateScope: Event.None,
      onWillClose: willClose.event,
      onDidClose: didClose.event,
      create: vi.fn(),
      fork: vi.fn(),
      get: (agentId: string) =>
        handles.has(agentId) && !closingAgents.has(agentId) ? stubAgentContext(agentId) : undefined,
      handleOf: (agentId: string) =>
        closingAgents.has(agentId) ? undefined : handles.get(agentId),
      list: () => [],
      remove: removeAgent,
      broadcastPermissionMode: () => {},
      adopt: () => stubAgentContext('unused'),
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionEventBus, bus);
    ix.stub(ILogService, logs.log);
    vi.stubEnv(SUBAGENT_SCOPE_CACHE_SIZE_ENV, '1');
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllEnvs();
  });

  function startCache(env: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    ix.set(ISessionSubagentScopeCacheService, new SyncDescriptor(SessionSubagentScopeCacheService));
    ix.get(ISessionSubagentScopeCacheService);
  }

  function loopHandle(
    agentId: string,
    snapshot: () => LoopSnapshot,
    flush: () => Promise<void> = async () => {},
  ): IAgentScopeHandle {
    return {
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (serviceId: unknown) =>
          serviceId === IAgentLoopService
            ? ({ _serviceBrand: undefined, snapshot } as unknown as IAgentLoopService)
            : serviceId === IAgentTaskService
              ? ({ _serviceBrand: undefined, list: () => [] } as unknown as IAgentTaskService)
              : serviceId === IEventDispatcher
                ? ({ _serviceBrand: undefined, flush } as unknown as IEventDispatcher)
                : undefined,
      } as IAgentScopeHandle['accessor'],
      dispose: () => {},
    };
  }

  function idleHandle(agentId: string): IAgentScopeHandle {
    return loopHandle(agentId, () => ({
      state: 'idle',
      queue: [],
      notificationCount: 0,
      paused: false,
      hasPendingRequests: false,
    }));
  }

  it('skips a running subagent without letting it jam the eviction queue', async () => {
    startCache();
    handles.set(
      'agent-1',
      loopHandle('agent-1', () => ({
        state: 'running',
        activeTurnId: 1,
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: true,
      })),
    );
    handles.set('agent-2', idleHandle('agent-2'));

    bus.publish(new SubagentCompleted({ subagentId: 'agent-1', resultSummary: 'done' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-2', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledOnce();
    });
    expect(removeAgent.mock.calls[0]![0]).toMatchObject({ agentId: 'agent-2' });
    expect(handles.has('agent-1')).toBe(true);

    handles.set('agent-3', idleHandle('agent-3'));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-3', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledTimes(2);
    });
    expect(removeAgent.mock.calls[1]![0]).toMatchObject({ agentId: 'agent-3' });
    expect(handles.has('agent-1')).toBe(true);
  });

  it('retries a transiently busy subagent on every overflow pass and evicts it once it settles', async () => {
    startCache();
    const runningSnapshot = {
      state: 'running',
      activeTurnId: 1,
      queue: [],
      notificationCount: 0,
      paused: false,
      hasPendingRequests: true,
    } as const;
    const idleSnapshot = {
      state: 'idle',
      queue: [],
      notificationCount: 0,
      paused: false,
      hasPendingRequests: false,
    } as const;
    let agent1Busy = true;
    handles.set(
      'agent-1',
      loopHandle('agent-1', () => (agent1Busy ? runningSnapshot : idleSnapshot)),
    );
    handles.set('agent-2', idleHandle('agent-2'));

    bus.publish(new SubagentCompleted({ subagentId: 'agent-1', resultSummary: 'done' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-2', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledOnce();
    });
    expect(removeAgent.mock.calls[0]![0]).toMatchObject({ agentId: 'agent-2' });

    const completeAndEvict = async (agentId: string): Promise<void> => {
      handles.set(agentId, idleHandle(agentId));
      bus.publish(new SubagentCompleted({ subagentId: agentId, resultSummary: 'done' }));
      await vi.waitFor(() => {
        expect(removeAgent.mock.calls.some((call) => call[0].agentId === agentId)).toBe(true);
      });
    };
    for (const agentId of ['agent-3', 'agent-4', 'agent-5']) {
      await completeAndEvict(agentId);
    }

    expect(handles.has('agent-1')).toBe(true);
    expect(removeAgent.mock.calls.some((call) => call[0].agentId === 'agent-1')).toBe(false);

    const deferred = logs.entries.filter(
      (entry) => entry.level === 'debug' && entry.message.includes('deferred'),
    );
    expect(deferred).toHaveLength(4);
    expect(deferred.map((entry) => (entry.payload as { agentId: string }).agentId)).toEqual([
      'agent-1',
      'agent-1',
      'agent-1',
      'agent-1',
    ]);
    expect(
      logs.entries.some((entry) => entry.level === 'warn' && entry.message.includes('abandoned')),
    ).toBe(false);

    agent1Busy = false;
    handles.set('agent-6', idleHandle('agent-6'));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-6', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent.mock.calls.some((call) => call[0].agentId === 'agent-1')).toBe(true);
    });
    expect(handles.has('agent-1')).toBe(false);
  });

  it('does not re-add a scope whose teardown completed despite a stop failure, and spawns no ghost evictions', async () => {
    startCache();
    removeAgent.mockImplementation((context: AgentContext) => {
      closingAgents.add(context.agentId);
      willClose.fire(context);
      handles.delete(context.agentId);
      closingAgents.delete(context.agentId);
      didClose.fire(context);
      return context.agentId === 'agent-old'
        ? Promise.reject(new Error('stop failed'))
        : Promise.resolve();
    });
    handles.set('agent-old', idleHandle('agent-old'));
    handles.set('agent-new', idleHandle('agent-new'));

    bus.publish(new SubagentCompleted({ subagentId: 'agent-old', resultSummary: 'done' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-new', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(
        logs.entries.some(
          (entry) => entry.level === 'warn' && entry.message.includes('eviction failed'),
        ),
      ).toBe(true);
    });

    expect(handles.has('agent-old')).toBe(false);
    expect(handles.has('agent-new')).toBe(true);
    expect(removeAgent.mock.calls.some((call) => call[0].agentId === 'agent-new')).toBe(false);

    handles.set('agent-later', idleHandle('agent-later'));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-later', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent.mock.calls.some((call) => call[0].agentId === 'agent-new')).toBe(true);
    });
    expect(removeAgent.mock.calls.some((call) => call[0].agentId === 'agent-later')).toBe(false);
    expect(removeAgent.mock.calls.filter((call) => call[0].agentId === 'agent-old')).toHaveLength(1);
    expect(handles.has('agent-later')).toBe(true);
  });

  it('times out a hung remove, keeps tracking the closing scope, and keeps the queue moving', async () => {
    startCache({ [SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV]: '25' });
    removeAgent.mockImplementation((context: AgentContext) => {
      if (context.agentId === 'agent-1') {
        closingAgents.add(context.agentId);
        willClose.fire(context);
        return new Promise<void>(() => {});
      }
      closingAgents.add(context.agentId);
      willClose.fire(context);
      handles.delete(context.agentId);
      closingAgents.delete(context.agentId);
      didClose.fire(context);
      return Promise.resolve();
    });
    handles.set('agent-1', idleHandle('agent-1'));
    handles.set('agent-2', idleHandle('agent-2'));

    bus.publish(new SubagentCompleted({ subagentId: 'agent-1', resultSummary: 'done' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-2', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledTimes(2);
    });
    expect(removeAgent.mock.calls[0]![0]).toMatchObject({ agentId: 'agent-1' });
    expect(removeAgent.mock.calls[1]![0]).toMatchObject({ agentId: 'agent-2' });
    expect(handles.has('agent-1')).toBe(true);
    expect(handles.has('agent-2')).toBe(false);

    const timedOut = logs.entries.filter(
      (entry) => entry.level === 'warn' && entry.message.includes('timed out'),
    );
    expect(timedOut).toHaveLength(1);
    expect((timedOut[0]!.payload as { agentId: string }).agentId).toBe('agent-1');

    handles.set('agent-3', idleHandle('agent-3'));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-3', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledTimes(3);
    });
    expect(removeAgent.mock.calls[2]![0]).toMatchObject({ agentId: 'agent-3' });

    handles.set('agent-4', idleHandle('agent-4'));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-4', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledTimes(4);
    });
    expect(removeAgent.mock.calls[3]![0]).toMatchObject({ agentId: 'agent-4' });

    expect(
      logs.entries.filter(
        (entry) => entry.level === 'warn' && entry.message.includes('timed out'),
      ),
    ).toHaveLength(1);
  });

  it('evicts the oldest retired scope after an awaited eviction, not one re-retired meanwhile', async () => {
    startCache();
    const firstRemoval = createControlledPromise<void>();
    removeAgent.mockImplementationOnce(async (context: AgentContext) => {
      closingAgents.add(context.agentId);
      willClose.fire(context);
      await firstRemoval;
      handles.delete(context.agentId);
      closingAgents.delete(context.agentId);
      didClose.fire(context);
    });
    for (const agentId of ['agent-a', 'agent-b', 'agent-c']) handles.set(agentId, idleHandle(agentId));

    bus.publish(new SubagentCompleted({ subagentId: 'agent-a', resultSummary: 'done' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-b', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledOnce();
    });
    bus.publish(new SubagentCompleted({ subagentId: 'agent-c', resultSummary: 'done' }));
    bus.publish(new SubagentStarted({ subagentId: 'agent-b' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-b', resultSummary: 'done again' }));
    firstRemoval.resolve();

    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removeAgent.mock.calls.map((call) => call[0].agentId)).toEqual(['agent-a', 'agent-c']);
    expect(handles.has('agent-b')).toBe(true);
  });

  it('keeps a retired scope resident while its wire flush fails and evicts it once the flush succeeds', async () => {
    startCache();
    let flushFailures = 1;
    const flush = vi.fn(async () => {
      if (flushFailures > 0) {
        flushFailures -= 1;
        throw new Error('ENOSPC: no space left on device');
      }
    });
    const idle = (): LoopSnapshot => ({
      state: 'idle',
      queue: [],
      notificationCount: 0,
      paused: false,
      hasPendingRequests: false,
    });
    handles.set('agent-1', loopHandle('agent-1', idle, flush));
    handles.set('agent-2', idleHandle('agent-2'));

    bus.publish(new SubagentCompleted({ subagentId: 'agent-1', resultSummary: 'done' }));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-2', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledOnce();
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(removeAgent.mock.calls[0]![0]).toMatchObject({ agentId: 'agent-2' });
    expect(handles.has('agent-1')).toBe(true);

    handles.set('agent-3', idleHandle('agent-3'));
    bus.publish(new SubagentCompleted({ subagentId: 'agent-3', resultSummary: 'done' }));
    await vi.waitFor(() => {
      expect(removeAgent).toHaveBeenCalledTimes(2);
    });
    expect(removeAgent.mock.calls[1]![0]).toMatchObject({ agentId: 'agent-1' });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(handles.has('agent-3')).toBe(true);
  });
});
