import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentProfileService } from '#/agent/profile/profile';
import '#/agent/profile/profileService';
import { ProfileBind } from '#/agent/profile/profileOps';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import '#/agent/permissionMode/permissionModeService';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
} from '#/agent/permissionMode/permissionModeOps';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import '#/agent/contextMemory/contextMemoryService';
import { INHERITED_IN_FLIGHT_TOOL_OUTPUT } from '#/agent/contextMemory/openToolExchange';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ToolCall } from '#/kosong/contract/message';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { createMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import '#/agent/mcp/mcpService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import '#/wire/wireService';
import '#/state/eventDispatcherService';
import { IAgentTaskService } from '#/agent/task/task';
import { AgentCron, cronAgentRuntimeProvider } from '#/features/cron/cronAgentRuntime';
import { ICronCreateTool } from '#/features/cron/tools/cron-create/cron-create';
import { ICronDeleteTool } from '#/features/cron/tools/cron-delete/cron-delete';
import { ICronListTool } from '#/features/cron/tools/cron-list/cron-list';
import { CRON_SECTION } from '#/features/cron/configSection';
import { interactionAgentRuntimeProvider } from '#/features/interaction/interactionAgentRuntime';
import { Ledger } from '#/_base/lifecycle/ledger';
import { BugIndicatingError } from '#/_base/errors/errors';
import { AgentRuntimeContributionPoint } from '#/agent/runtime/agentRuntime';
import { TODO_LIST_REMINDER_VARIANT } from '#/features/todo/todoListReminder';
import { AgentTodo, todoAgentRuntimeProvider } from '#/features/todo/todoAgentRuntime';
import '#/agent/toolDedupe/toolDedupeService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import '#/app/event/eventBusService';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { _clearAgentToolContributionsForTests } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import '#/agent/toolActivation/toolActivationService';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
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

function recordingAppendLog(initial: readonly WireRecord[] = []): {
  readonly appended: WireRecord[];
  readonly store: IAppendLogStore;
  rewritten?: readonly WireRecord[];
} {
  const records = [...initial];
  const appended: WireRecord[] = [];
  const state: { rewritten?: readonly WireRecord[] } = {};
  const store: IAppendLogStore = {
    _serviceBrand: undefined,
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
    flush: () => Promise.resolve(),
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
  };
}

function stubBlobPassThrough(ix: TestInstantiationService): void {
  ix.stub(IAgentBlobService, {
    _serviceBrand: undefined,
    offloadParts: async (parts) => parts,
    loadParts: async (parts) => parts,
    isBlobRef: () => false,
  } satisfies IAgentBlobService);
}

describe('AgentLifecycleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registerAgent: ReturnType<typeof vi.fn<ISessionMetadata['registerAgent']>>;
  let atomicDocs: Map<string, unknown>;
  let permissionModeSetMode: ReturnType<typeof vi.fn>;
  let stopAllOnExit: ReturnType<typeof vi.fn>;
  let loopActiveTurnId: number | undefined;
  let loopPendingTurnIds: number[];
  let loopCancel: ReturnType<typeof vi.fn<IAgentLoopService['cancel']>>;
  let loopSettled: ReturnType<typeof vi.fn<IAgentLoopService['settled']>>;
  let promptDrain: ReturnType<typeof vi.fn<IAgentPromptService['drain']>>;
  let beforeExecuteListeners: number;
  let didExecuteHookIds: string[];

  beforeEach(() => {
    _clearAgentToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(ISessionEventBus, new SyncDescriptor(EventBusService));
    ix.get(IAgentStateService).contributeState(permissionModeKey);
    ix.get(IAgentStateService).contributeState(permissionModeConfiguredKey);
    ix.stub(IAppendLogStore, recordingAppendLog().store);
    stubBlobPassThrough(ix);
    registerAgent = vi.fn<ISessionMetadata['registerAgent']>().mockResolvedValue(undefined);
    atomicDocs = new Map();
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-agentLifecycle-test',
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
      registerAgent,
    });
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/tmp/kimi-agentLifecycle-home',
      cwd: '/tmp/kimi-agentLifecycle-home',
    } as unknown as IBootstrapService);
    ix.stub(ISessionWorkspaceContext, {
      _serviceBrand: undefined,
      workDir: '/tmp/kimi-agentLifecycle-work',
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
      watch: () => Event.None as Event<void>,
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
    beforeExecuteListeners = 0;
    didExecuteHookIds = [];
    ix.stub(IAgentToolExecutorService, {
      _serviceBrand: undefined,
      onBeforeExecuteTool: () => {
        beforeExecuteListeners += 1;
        return { dispose: () => {} };
      },
      onWillExecuteTool: () => ({ dispose: () => {} }),
      hooks: {
        onDidExecuteTool: {
          register: (id: string) => {
            didExecuteHookIds.push(id);
            return { dispose: () => {} };
          },
        },
      },
    } as unknown as IAgentToolExecutorService);
    loopActiveTurnId = undefined;
    loopPendingTurnIds = [];
    loopCancel = vi.fn<IAgentLoopService['cancel']>((turnId) => {
      if (turnId === undefined) {
        loopActiveTurnId = undefined;
      } else {
        loopPendingTurnIds = loopPendingTurnIds.filter((id) => id !== turnId);
      }
      return true;
    });
    loopSettled = vi.fn<IAgentLoopService['settled']>(async () => {
      if (loopActiveTurnId !== undefined || loopPendingTurnIds.length > 0) {
        throw new Error('Agent loop did not settle');
      }
    });
    ix.stub(IAgentLoopService, {
      _serviceBrand: undefined,
      hooks: {
        onWillBeginStep: { register: () => ({ dispose: () => {} }) },
        onDidFinishStep: { register: () => ({ dispose: () => {} }) },
      },
      registerLoopErrorHandler: () => ({ dispose: () => {} }),
      status: () => ({
        state: loopActiveTurnId === undefined ? 'idle' : 'running',
        activeTurnId: loopActiveTurnId,
        pendingTurnIds: loopPendingTurnIds,
        hasPendingRequests: loopActiveTurnId !== undefined || loopPendingTurnIds.length > 0,
      }),
      cancel: loopCancel,
      settled: loopSettled,
    } as unknown as IAgentLoopService);
    promptDrain = vi.fn<IAgentPromptService['drain']>(async () => {});
    ix.stub(IAgentPromptService, {
      _serviceBrand: undefined,
      drain: promptDrain,
    } as unknown as IAgentPromptService);
    ix.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track2: () => {},
      withContext: () => ({
        _serviceBrand: undefined,
        track2: () => {},
      }) as unknown as ITelemetryService,
    } as unknown as ITelemetryService);
    ix.stub(IAgentTelemetryContextService, {
      _serviceBrand: undefined,
      get: () => ({ mode: 'agent' }),
      set: () => {},
    });
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
    ix.stub(IAgentContextInjectorService, {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentContextInjectorService);
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
    permissionModeSetMode = vi.fn();
    ix.stub(IAgentPermissionModeService, {
      _serviceBrand: undefined,
      mode: 'manual',
      setMode: permissionModeSetMode,
      onDidChangeMode: Event.None,
    } as unknown as IAgentPermissionModeService);
    ix.stub(ISessionInstructionsProvider, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      agentsMd: undefined,
      agentsMdWarning: undefined,
      agentsMdPaths: undefined,
      onDidChange: Event.None as Event<void>,
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
    stopAllOnExit = vi.fn(async () => []);
    ix.stub(IAgentTaskService, {
      _serviceBrand: undefined,
      stopAllOnExit,
    } as unknown as IAgentTaskService);
    ix.stub(IAgentFullCompactionService, {
      _serviceBrand: undefined,
      compacting: null,
    } as unknown as IAgentFullCompactionService);
    ix.set(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService));
  });
  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
  });

  function contributeTodo(): () => void {
    return ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test',
      new Ledger('test'),
      todoAgentRuntimeProvider,
    );
  }

  function contributeCron(): () => void {
    return ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test',
      new Ledger('test'),
      cronAgentRuntimeProvider,
    );
  }

  function contributeInteraction(): () => void {
    return ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test',
      new Ledger('test'),
      interactionAgentRuntimeProvider,
    );
  }

  it('create / get / list / remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    expect(main.agentId).toBe('main');
    expect(svc.get('main')).toBe(main);
    expect(svc.handleOf('main')).toBeDefined();
    expect(svc.list()).toEqual([main]);
    await svc.remove(main);
    expect(svc.get('main')).toBeUndefined();
    expect(svc.handleOf('main')).toBeUndefined();
  });

  it('remove stops the agent background tasks before disposal', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    await svc.remove(main);

    expect(stopAllOnExit).toHaveBeenCalledWith('Session closed');
    expect(promptDrain).toHaveBeenCalledOnce();
  });

  it('remove waits for prompt intake to drain before disposing the agent scope', async () => {
    let releaseDrain!: () => void;
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    promptDrain.mockImplementationOnce(() => {
      markDrainStarted();
      return new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const disposed: string[] = [];
    disposables.add(svc.onDidClose((agent) => disposed.push(agent.agentId)));

    const removal = svc.remove(main);
    await drainStarted;
    await Promise.resolve();

    expect(disposed).toEqual([]);

    releaseDrain();
    await removal;
    expect(disposed).toEqual(['main']);
  });

  it('remove cancels queued turns before waiting for the active turn to settle', async () => {
    loopActiveTurnId = 1;
    loopPendingTurnIds = [2, 3];
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    await svc.remove(main);

    expect(loopCancel.mock.calls.map(([turnId]) => turnId)).toEqual([2, 3, undefined]);
    expect(loopSettled).toHaveBeenCalledOnce();
  });

  it('remove waits for an active full compaction to reject after aborting it', async () => {
    const abortController = new AbortController();
    let rejectCompaction!: (reason: unknown) => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectCompaction = reject;
    });
    const aborted = new Promise<void>((resolve) => {
      abortController.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    ix.stub(IAgentFullCompactionService, {
      _serviceBrand: undefined,
      compacting: {
        abortController,
        promise,
        trigger: 'manual',
        tokenCount: 100,
      },
    } as unknown as IAgentFullCompactionService);
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    let removed = false;
    const removal = svc.remove(main).then(() => {
      removed = true;
    });
    await aborted;
    await Promise.resolve();
    expect(removed).toBe(false);

    rejectCompaction(abortController.signal.reason);
    await removal;
    expect(removed).toBe(true);
  });

  it('ignites the self-wiring toolDedupe plugin so its listeners exist before the first turn', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    expect(beforeExecuteListeners).toBeGreaterThan(0);
    expect(didExecuteHookIds).toContain('toolDedupe');
  });

  it('create skips auto ids that collide with agents persisted by a previous run', async () => {
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () =>
        Promise.resolve({
          id: 'sess_test',
          createdAt: 0,
          updatedAt: 0,
          archived: false,
          agents: {
            'agent-0': { homedir: '/tmp/kimi-agentLifecycle-test/agents/agent-0', type: 'sub' },
            'agent-1': { homedir: '/tmp/kimi-agentLifecycle-test/agents/agent-1', type: 'sub' },
          },
        }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent,
    });
    const svc = ix.get(IAgentLifecycleService);

    const first = await svc.create({});
    expect(first.agentId).toBe('agent-2');

    const second = await svc.create({});
    expect(second.agentId).toBe('agent-3');
  });

  it('seeds each agent scope with a telemetry view bound to its own agent id', async () => {
    const records: TelemetryRecord[] = [];
    ix.stub(ITelemetryService, recordingTelemetry(records));
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const sub = await svc.create({});

    svc.handleOf('main')!.accessor.get(ITelemetryService).track2('yolo_toggle', { enabled: true });
    svc.handleOf(sub.agentId)!.accessor.get(ITelemetryService).track2('yolo_toggle', { enabled: false });

    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: 'main', enabled: true },
    });
    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: sub.agentId, enabled: false },
    });
  });

  it('create assigns sequential ids when unspecified', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const a = await svc.create({});
    const b = await svc.create({});
    expect(a.agentId).not.toBe(b.agentId);
  });

  it('persists complete agent metadata when creating a child', async () => {
    const svc = ix.get(IAgentLifecycleService);

    const child = await svc.create({
      agentId: 'child',
      forkedFrom: 'main',
      labels: { swarmItem: 'swarm-item-1' },
    });

    expect(child.agentId).toBe('child');
    expect(registerAgent).toHaveBeenCalledWith('child', {
      homedir: '/tmp/kimi-agentLifecycle-home/sessions/ws_test/sess_test/agents/child',
      type: 'sub',
      parentAgentId: 'main',
      forkedFrom: 'main',
      labels: { swarmItem: 'swarm-item-1' },
    });
  });

  it('seals a fresh wire log with the metadata envelope as the first record', async () => {
    const log = recordingAppendLog();
    ix.stub(IAppendLogStore, log.store);
    const svc = ix.get(IAgentLifecycleService);

    await svc.create({ agentId: 'main' });

    expect(log.appended[0]).toMatchObject({
      type: 'metadata',
      protocol_version: createWireMetadataRecord().protocol_version,
    });
  });

  it('does not re-seal a wire log that already has records', async () => {
    const existing: WireRecord = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'existing' }],
      origin: { kind: 'user' },
    };
    const log = recordingAppendLog([existing]);
    ix.stub(IAppendLogStore, log.store);
    const svc = ix.get(IAgentLifecycleService);

    await svc.create({ agentId: 'main' });

    expect(log.appended.some((record) => record.type === 'metadata')).toBe(false);
  });

  it('leaves permission mode at the default when permissionMode is omitted', async () => {
    const svc = ix.get(IAgentLifecycleService);

    await svc.create({ agentId: 'child' });
    expect(permissionModeSetMode).not.toHaveBeenCalled();
  });

  it('applies the configured permission mode when the Agent has no persisted mode', async () => {
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => 'auto') as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);

    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    expect(svc.handleOf('main')!.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('auto');
  });

  it('keeps the restored permission mode instead of overwriting it with the default', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      { type: 'permission.set_mode', mode: 'manual', time: 2 },
    ]).store);
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => 'auto') as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);

    await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    expect(permissionModeSetMode).not.toHaveBeenCalled();
  });

  it('restores the runtime binding without persisting a generation', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      { type: 'runtime.set_binding', workspaceId: 'ws_test', runtimeId: 'remote', time: 2 },
    ]).store);

    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const agent = svc.handleOf('main')!;

    expect(agent.accessor.get(IAgentRuntimeBindingService).current).toEqual({
      workspaceId: 'ws_test',
      runtimeId: 'remote',
    });
    expect(agent.accessor.get(IAgentRuntimeService).inspect().identity.generation).toBe('remote-one');
  });

  it('attaches durable runtimes before restore and replays their records', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'bridged', status: 'pending' }],
        time: 2,
      },
      { type: 'interaction.request', id: 'i1', kind: 'question', request: { q: 1 }, time: 3 },
      {
        type: 'cron.add',
        task: { id: 'cron-1', cron: '0 9 * * *', prompt: 'ping', createdAt: 1, recurring: true },
        time: 4,
      },
    ]).store);
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: ((section: unknown) =>
        section === CRON_SECTION ? { disabled: true } : undefined) as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);
    ix.stub(IAgentToolRegistryService, {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentToolRegistryService);
    ix.stub(ICronCreateTool, { _serviceBrand: undefined });
    ix.stub(ICronListTool, { _serviceBrand: undefined });
    ix.stub(ICronDeleteTool, { _serviceBrand: undefined });
    contributeTodo();
    contributeCron();
    contributeInteraction();

    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    const contributions = svc.inspect(main).contributions;
    expect(contributions.find((line) => line.id === 'todo')?.state).toEqual([
      { title: 'bridged', status: 'pending' },
    ]);
    expect(contributions.find((line) => line.id === 'interaction')?.state).toEqual([
      { id: 'i1', kind: 'question', resolved: false },
    ]);
    expect(contributions.find((line) => line.id === 'cron')?.state).toEqual([
      { id: 'cron-1', cron: '0 9 * * *', recurring: true, createdAt: 1, lastFiredAt: undefined },
    ]);
  });

  it('waits for Cron restore readiness before create returns', async () => {
    let releaseConfig!: () => void;
    const configReady = new Promise<void>((resolve) => { releaseConfig = resolve; });
    ix.stub(IConfigService, {
      ready: configReady,
      get: ((section: unknown) => section === CRON_SECTION
        ? { debug: false, noJitter: true, noStale: false, disabled: false, manualTick: true }
        : undefined) as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
    } as unknown as IConfigService);
    contributeCron();
    const svc = ix.get(IAgentLifecycleService);
    let created = false;

    const creation = svc.create({ agentId: 'main' }).then((agent) => {
      created = true;
      return agent;
    });
    await vi.waitFor(() => { expect(registerAgent).toHaveBeenCalledOnce(); });

    expect(created).toBe(false);

    releaseConfig();
    const agent = await creation;

    expect(created).toBe(true);
    expect(svc.resolve(agent, AgentCron).isDisabled()).toBe(false);
  });

  it('broadcastPermissionMode sets the mode on every live agent', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    await svc.create({ agentId: 'child' });

    svc.broadcastPermissionMode('yolo');

    expect(svc.handleOf('main')!.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('yolo');
    expect(svc.handleOf('child')!.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('yolo');
  });

  it('broadcastPermissionMode skips agents that have been removed', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const child = await svc.create({ agentId: 'child' });
    await svc.remove(child);

    svc.broadcastPermissionMode('auto');

    expect(svc.handleOf('main')!.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('auto');
  });

  it('broadcastPermissionMode leaves tower-worker agents pinned to their spawned mode', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    await svc.create({ agentId: 'worker-1' });
    void svc.handleOf('worker-1')!.accessor.get(IEventDispatcher).dispatch(
      new ProfileBind({
        agentId: 'worker-1',
        profileName: TOWER_WORKER_PROFILE,
        thinkingEffort: 'off',
        systemPrompt: '',
        disallowedTools: [],
      }),
    );

    svc.broadcastPermissionMode('yolo');

    expect(svc.handleOf('main')!.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('yolo');
    expect(svc.handleOf('worker-1')!.accessor.get(IAgentStateService).get(permissionModeKey)).toBe('manual');
  });

  it('wires MCP OAuth credentials through the session atomic document store', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    const mcp = svc.handleOf('main')!.accessor.get(IAgentMcpService);
    const oauth = mcp.oauthService;
    if (oauth === undefined) throw new Error('Expected session MCP manager to provide OAuth');
    const provider = oauth.getProvider('linear', 'https://linear.example.com/mcp');
    await provider.ready;

    await provider.saveTokens({
      access_token: 'session-token',
      token_type: 'Bearer',
    } satisfies OAuthTokens);

    const tokenEntries = [...atomicDocs.entries()].filter(
      ([key]) => key.startsWith('credentials/mcp/') && key.endsWith('-tokens.json'),
    );
    expect(tokenEntries).toEqual([
      [
        expect.stringMatching(/^credentials\/mcp\/linear-[a-f0-9]{24}-tokens\.json$/),
        {
          access_token: 'session-token',
          token_type: 'Bearer',
          obtained_at: expect.any(Number),
        },
      ],
    ]);
  });

  it('returns an agent without waiting for the MCP handle readiness', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    ix.stub(ISessionMcpHandle, {
      _serviceBrand: undefined,
      ready,
      connectionManager: new McpConnectionManager({ log: noopLog }),
      isBaselineServer: () => true,
    } satisfies ISessionMcpHandle);

    const svc = ix.get(IAgentLifecycleService);
    const handle = await svc.create({ agentId: 'main' });
    expect(handle.agentId).toBe('main');

    releaseReady();
  });

  it('exposes the in-flight handle and joins it after bootstrap', async () => {
    let releaseRegister!: () => void;
    let registerStarted!: () => void;
    const registerCalled = new Promise<void>((resolve) => {
      registerStarted = resolve;
    });
    registerAgent.mockImplementationOnce(() => {
      registerStarted();
      return new Promise<void>((resolve) => {
        releaseRegister = resolve;
      });
    });
    const svc = ix.get(IAgentLifecycleService);
    const create = svc.create({ agentId: 'main' });

    const early = svc.handleOf('main');
    expect(early).toBeDefined();

    const joined = svc.create({ agentId: 'main' });
    await registerCalled;
    releaseRegister();
    const handle = await joined;
    const created = await create;
    expect(handle).toBe(created);
    expect(svc.handleOf('main')).toBe(early);
  });

  it('ensureMainAgent returns one handle when calls start concurrently', async () => {
    const session: ISessionScopeHandle = {
      id: 'sess_test',
      kind: LifecycleScope.Session,
      accessor: ix,
      dispose: () => {},
    };

    const [first, second] = await Promise.all([
      ensureMainAgent(session),
      ensureMainAgent(session),
    ]);

    expect(first).toBe(second);
    expect(registerAgent).toHaveBeenCalledTimes(1);
    expect(ix.get(IAgentLifecycleService).list()).toEqual([first]);
  });

  it('drops the handle when creation bootstrap fails so the next create starts clean', async () => {
    registerAgent.mockRejectedValueOnce(new Error('bootstrap boom'));
    const svc = ix.get(IAgentLifecycleService);

    await expect(svc.create({ agentId: 'main' })).rejects.toThrow('bootstrap boom');
    expect(svc.get('main')).toBeUndefined();
    expect(svc.handleOf('main')).toBeUndefined();

    const main = await svc.create({ agentId: 'main' });
    expect(main.agentId).toBe('main');
  });

  it('fork throws when the source agent does not exist', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await expect(svc.fork(stubAgentContext('missing'))).rejects.toThrow(
      'Source agent "missing" does not exist',
    );
  });

  it('fork copies the bound profile snapshot without catalog resolution', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    svc.handleOf('main')!.accessor.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      subagents: ['explore'],
    });

    const child = await svc.fork(source, { agentId: 'forked' });

    expect(svc.handleOf(child.agentId)!.accessor.get(IAgentProfileService).data()).toMatchObject({
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      subagents: ['explore'],
    });
  });

  it('fork snapshots the source runtime and remains independent', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    const sourceRuntime = svc.handleOf('main')!.accessor.get(IAgentRuntimeBindingService);
    sourceRuntime.switch('remote');

    const child = await svc.fork(source, { agentId: 'forked-runtime' });
    const childRuntime = svc.handleOf(child.agentId)!.accessor.get(IAgentRuntimeBindingService);
    expect(childRuntime.current.runtimeId).toBe('remote');

    sourceRuntime.switch('local');
    expect(childRuntime.current.runtimeId).toBe('remote');
    childRuntime.switch('local');
    expect(sourceRuntime.current.runtimeId).toBe('local');
  });

  it('fork seeds the child context, closing the trailing open tool exchange', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    const sourceHandle = svc.handleOf('main')!;
    const agentCall: ToolCall = {
      type: 'function',
      id: 'call_agent',
      name: 'Agent',
      arguments: '{}',
    };
    const history: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'analyze this repo' }], toolCalls: [] },
      { role: 'assistant', content: [], toolCalls: [agentCall], partial: true },
    ];
    sourceHandle.accessor.get(IAgentContextMemoryService).append(...history);

    const child = await svc.fork(agentContextOf(sourceHandle), { agentId: 'forked' });

    const seeded = svc.handleOf(child.agentId)!.accessor.get(IAgentContextMemoryService).get();
    expect(seeded).toHaveLength(3);
    expect(seeded[0]).toMatchObject({ role: 'user' });
    expect(seeded[1]).toMatchObject({ role: 'assistant', partial: undefined });
    expect(seeded[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_agent',
      content: [{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }],
    });
  });

  it('fork leaves the child context empty when the source history is empty', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });

    const child = await svc.fork(agentContextOf(svc.handleOf(source.agentId)!), { agentId: 'forked' });

    expect(
      svc.handleOf(child.agentId)!.accessor.get(IAgentContextMemoryService).get(),
    ).toEqual([]);
  });

  it('fork passes labels through to the registered agent metadata', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });

    await svc.fork(agentContextOf(svc.handleOf(source.agentId)!), {
      agentId: 'forked',
      labels: { parentAgentId: 'main' },
    });

    expect(registerAgent).toHaveBeenCalledWith(
      'forked',
      expect.objectContaining({ forkedFrom: 'main', labels: { parentAgentId: 'main' } }),
    );
  });

  it('run throws when the agent does not exist', () => {
    ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
    const svc = ix.get(ISessionSubagentService);
    expect(() =>
      svc.run(
        stubAgentContext('missing'),
        { kind: 'prompt', prompt: 'hi' },
        { signal: new AbortController().signal },
      ),
    ).toThrow('Agent "missing" does not exist');
  });

  it('fires onDidCreate on create and onDidClose on remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const created: string[] = [];
    const closed: string[] = [];
    disposables.add(svc.onDidCreate((agent) => created.push(agent.agentId)));
    disposables.add(svc.onDidClose((agent) => closed.push(agent.agentId)));

    const a = await svc.create({});
    expect(created).toEqual([a.agentId]);

    await svc.remove(a);
    expect(closed).toEqual([a.agentId]);
  });

  it('assigns a new lifecycle generation when recreating the same agent id', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const first = await svc.create({ agentId: 'main' });
    expect(svc.get('main')).toBe(first);

    await svc.remove(first);
    expect(svc.get('main')).toBeUndefined();
    const second = await svc.create({ agentId: 'main' });

    expect(second.agentId).toBe(first.agentId);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second).not.toBe(first);
    expect(svc.get('main')).toBe(second);
  });

  it('rejects a stale context after the same agent id is recreated', async () => {
    contributeTodo();
    const svc = ix.get(IAgentLifecycleService);
    const first = await svc.create({ agentId: 'main' });
    await svc.remove(first);
    const second = await svc.create({ agentId: 'main' });

    expect(() => svc.resolve(first, AgentTodo)).toThrow('is not a lifecycle-issued context');
    expect(() => svc.inspect(first)).toThrow('is not a lifecycle-issued context');
    expect(svc.resolve(second, AgentTodo).get()).toEqual([]);
  });

  it('rejects a forged context that the manager never issued', async () => {
    contributeTodo();
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const forged: AgentContext = {
      agentId: main.agentId,
      generation: main.generation,
      space: main.space,
    };

    expect(() => svc.resolve(forged, AgentTodo)).toThrow('is not a lifecycle-issued context');
    expect(() => svc.inspect(forged)).toThrow('is not a lifecycle-issued context');

    await svc.remove(main);
    expect(() => svc.resolve(main, AgentTodo)).toThrow('is not a lifecycle-issued context');
  });

  it('retires agent runtimes before disposing the agent scope on remove', async () => {
    const order: string[] = [];
    let reminders = 0;
    ix.stub(IAgentContextInjectorService, {
      _serviceBrand: undefined,
      register: (variant: string) => {
        if (variant !== TODO_LIST_REMINDER_VARIANT) return { dispose: () => {} };
        reminders += 1;
        return {
          dispose: () => {
            reminders -= 1;
            order.push('reminder-disposed');
          },
        };
      },
    } as unknown as IAgentContextInjectorService);
    contributeTodo();
    const svc = ix.get(IAgentLifecycleService);
    const willClose: string[] = [];
    disposables.add(svc.onWillClose((agent) => willClose.push(agent.agentId)));
    const main = await svc.create({ agentId: 'main' });
    const handle = svc.handleOf('main')!;
    const originalDispose = handle.dispose.bind(handle);
    handle.dispose = () => {
      order.push('scope-disposed');
      originalDispose();
    };
    svc.resolve(main, AgentTodo).get();
    expect(reminders).toBe(1);

    await svc.remove(main);

    expect(willClose).toEqual(['main']);
    expect(reminders).toBe(0);
    expect(order).toEqual(['reminder-disposed', 'scope-disposed']);
    expect(svc.handleOf('main')).toBeUndefined();
  });

  it('rejects a durable participant attached after restore started', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const dispatcher = svc.handleOf('main')!.accessor.get(IEventDispatcher);

    expect(() =>
      dispatcher.attach({
        id: 'late-runtime',
        events: [],
        undoable: false,
        transition: () => undefined,
        getState: () => ({}),
        commit: () => {},
      }),
    ).toThrow(BugIndicatingError);
  });

  it('retires a withdrawn runtime definition and rejects new resolves', async () => {
    let reminders = 0;
    ix.stub(IAgentContextInjectorService, {
      _serviceBrand: undefined,
      register: (variant: string) => {
        if (variant !== TODO_LIST_REMINDER_VARIANT) return { dispose: () => {} };
        reminders += 1;
        return {
          dispose: () => {
            reminders -= 1;
          },
        };
      },
    } as unknown as IAgentContextInjectorService);
    const withdraw = contributeTodo();
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    svc.resolve(main, AgentTodo).get();
    expect(reminders).toBe(1);

    withdraw();

    await vi.waitFor(() => { expect(reminders).toBe(0); });
    expect(() => svc.resolve(main, AgentTodo)).toThrow('unavailable');
    expect(svc.inspect(main).contributions[0]).toMatchObject({ id: 'todo', status: 'retired' });
  });

  it('de-dupes concurrent create calls for the same agent id', async () => {
    let resolveRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    registerAgent.mockReturnValue(registration);
    const svc = ix.get(IAgentLifecycleService);

    const first = svc.create({ agentId: 'main' });
    const second = svc.create({ agentId: 'main' });

    resolveRegistration();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('create returns the existing agent on a sequential duplicate id', async () => {
    const svc = ix.get(IAgentLifecycleService);

    const first = await svc.create({ agentId: 'main' });
    const second = await svc.create({ agentId: 'main' });

    expect(second).toBe(first);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });
});
