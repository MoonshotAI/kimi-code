import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import {
  AgentProfile,
  profileAgentRuntimeProvider,
} from '#/actor/profile/profileAgentRuntime';
import { ProfileBind } from '#/actor/profile/profileOps';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { ISessionAgentsMdReminderService } from '#/agent/agentsMdReminder/sessionAgentsMdReminderService';
import { ISessionCacheProbeService } from '#/agent/usage/sessionCacheProbeService';
import { ISessionToolResultTruncationService } from '#/agent/toolResultTruncation/sessionToolResultTruncationService';
import { ISessionInterruptionReminderService } from '#/agent/interruptionReminder/sessionInterruptionReminderService';
import { ISessionMediaService } from '#/agent/media/sessionMediaService';
import { ISessionTowerService } from '#/features/tower/sessionTowerService';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import {
  AgentPermissionMode,
  permissionModeAgentRuntimeProvider,
} from '#/actor/permissionMode/permissionModeAgentRuntime';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { SessionPermissionModeService } from '#/session/permissionMode/sessionPermissionModeService';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IGitService } from '#/app/git/git';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentContextMemory, contextMemoryAgentRuntimeProvider } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import {
  stubFullCompactionRuntime,
  stubFullCompactionRuntimeProvider,
} from '../../actor/fullCompaction/stubs';
import { reminderAgentRuntimeProvider } from '#/actor/reminder/reminderAgentRuntime';
import { INHERITED_IN_FLIGHT_TOOL_OUTPUT } from '#/actor/contextMemory/openToolExchange';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { IAgentHostService, type AgentHost, type AgentHostCreateInput } from '#/agent/host/agentHost';
import { AgentHostService } from '#/agent/host/agentHostService';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IFlagService } from '#/app/flag/flag';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ToolCall } from '#/kosong/contract/message';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { createMcpOAuthStore } from '#/app/mcpConfig/oauthStore';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import '#/wire/wireService';
import '#/state/eventDispatcherService';
import { stubTaskRuntimeProvider } from '../../actor/task/stubs';
import type { AgentTaskInfo } from '#/actor/task/types';
import { AgentCron, cronAgentRuntimeProvider } from '#/actor/cron/cronAgentRuntime';
import { ICronCreateTool } from '#/actor/cron/tools/cron-create/cron-create';
import { ICronDeleteTool } from '#/actor/cron/tools/cron-delete/cron-delete';
import { ICronListTool } from '#/actor/cron/tools/cron-list/cron-list';
import { CRON_SECTION } from '#/actor/cron/configSection';
import { interactionAgentRuntimeProvider } from '#/actor/interaction/interactionAgentRuntime';
import { Ledger } from '#/_base/lifecycle/ledger';
import { BugIndicatingError } from '#/_base/errors/errors';
import { AgentRuntimeContributionPoint } from '#/actor/agentRuntime';
import { AgentTodo, todoAgentRuntimeProvider } from '#/actor/todo/todoAgentRuntime';
import { undoAgentRuntimeProvider } from '#/actor/undo/undoAgentRuntime';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import '#/app/event/eventBusService';
import { AgentActivityUpdated } from '#/actor/activityView/activityViewEvents';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';
import { AgentTools, type AgentToolsRuntime, agentToolsRuntimeProvider } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { IAgentToolContributionSource } from '#/agent/toolRegistry/toolContributionSourceService';
import { permissionRulesAgentRuntimeProvider } from '#/actor/permissionRules/permissionRulesAgentRuntime';
import type { ToolExecutorDomain } from '#/actor/toolExecutor/internal/domain';
import type { ResolvedToolExecutionHookContext } from '#/actor/toolExecutor/toolHooks';
import type { LoopControl } from '#/actor/loop/internal/loop';
import { AgentLoop, type LoopActivity, type LoopRuntime, type TurnEndedEvent, type TurnStartedEvent } from '#/actor/loop/loop';
import { getLoopControl, registerLoopControl } from '#/actor/loop/internal/access';
import { AgentPrompt, promptAgentRuntimeProvider } from '#/actor/prompt/promptAgentRuntime';
import type { PromptRuntime } from '#/actor/prompt/prompt';
import { defineAgentRuntimeProvider } from '#/actor/agentRuntime';
import { stubToolExecutor } from '../../agent/loop/stubs';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/actor/skill/session/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { _clearAgentToolContributionsForTests } from '#/agent/toolRegistry/toolContribution';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { ScopeUnits } from '#/_base/di/fiber';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';
const LifecycleScope = { App: 'app', Session: 'session', Agent: 'agent' } as const;

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
  onDidMutate: () => ({ dispose: () => {} }),
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

const stubAgentToolsRuntimeProvider = defineAgentRuntimeProvider(AgentTools, {
  id: 'tools',
  eager: true,
  createApi: () => stubToolExecutor(),
});

const stubAgentLoopRuntimeProvider = defineAgentRuntimeProvider(AgentLoop, {
  id: 'loop',
  eager: true,
  createApi: (): LoopRuntime => ({
    run: async () => ({ status: 'idle' }),
    cancel: async () => {},
    cancelByUser: async () => {},
    status: () => 'idle',
    waitUntilSettled: async () => ({ status: 'idle' }),
    activity: () => ({}),
    onDidChangeActivity: Event.None as Event<LoopActivity>,
    onDidStartTurn: Event.None as Event<TurnStartedEvent>,
    onDidEndTurn: Event.None as Event<TurnEndedEvent>,
  }),
});

describe('AgentLifecycleService', () => {
  let stubFullCompactionCancel: () => Promise<void> = () => Promise.resolve();
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registerAgent: ReturnType<typeof vi.fn<ISessionMetadata['registerAgent']>>;
  let atomicDocs: Map<string, unknown>;
  let stopAllOnExit: (reason: string) => Promise<AgentTaskInfo[]>;
  let loopActiveTurnId: number | undefined;
  let loopPendingTurnIds: number[];
  let loopCancel: ReturnType<typeof vi.fn<LoopControl['cancel']>>;
  let loopSettled: ReturnType<typeof vi.fn<LoopControl['settled']>>;
  let promptDrain: ReturnType<typeof vi.fn<PromptRuntime['drain']>>;
  let withdrawStubToolExecutor: () => void = () => {};

  beforeEach(() => {
    stubFullCompactionCancel = () => Promise.resolve();
    _clearAgentToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionStateService, new SessionStateService());
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(ISessionEventBus, new SyncDescriptor(EventBusService));
    ix.set(ISessionPermissionModeService, new SyncDescriptor(SessionPermissionModeService));
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
      onDidChangeConfiguration: (() => ({ dispose: () => {} })) as unknown as IConfigService['onDidChangeConfiguration'],
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
    loopActiveTurnId = undefined;
    loopPendingTurnIds = [];
    loopCancel = vi.fn<LoopControl['cancel']>((turnId) => {
      if (turnId === undefined) {
        loopActiveTurnId = undefined;
      } else {
        loopPendingTurnIds = loopPendingTurnIds.filter((id) => id !== turnId);
      }
      return true;
    });
    loopSettled = vi.fn<LoopControl['settled']>(async () => {
      if (loopActiveTurnId !== undefined || loopPendingTurnIds.length > 0) {
        throw new Error('Agent loop did not settle');
      }
    });
    const loopControl = {
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
    } as unknown as LoopControl;
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
    ix.stub(ISessionUsageService, {
      _serviceBrand: undefined,
      onDidRecord: Event.None,
    } as unknown as ISessionUsageService);
    ix.stub(IProtocolAdapterRegistry, {
      _serviceBrand: undefined,
    } as IProtocolAdapterRegistry);
    ix.stub(IBuiltinAgentProfileLoader, {
      _serviceBrand: undefined,
    } as IBuiltinAgentProfileLoader);
    ix.stub(IAgentIdentity, { _serviceBrand: undefined } as IAgentIdentity);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: () => false,
      enabledIds: () => [],
    } as unknown as IFlagService);
    ix.stub(ISessionAgentsMdReminderService, {
      _serviceBrand: undefined,
      attach: () => {},
      of: () => ({ seedInjected: () => {} }),
    } as unknown as ISessionAgentsMdReminderService);
    ix.stub(ISessionCacheProbeService, {
      _serviceBrand: undefined,
      attach: () => {},
    } as unknown as ISessionCacheProbeService);
    ix.stub(ISessionToolResultTruncationService, {
      _serviceBrand: undefined,
      attach: () => {},
      of: () => ({ truncateForModel: async ({ result }: { result: unknown }) => result }),
    } as unknown as ISessionToolResultTruncationService);
    ix.stub(ISessionInterruptionReminderService, {
      _serviceBrand: undefined,
      attach: () => {},
    } as unknown as ISessionInterruptionReminderService);
    ix.stub(ISessionMediaService, {
      _serviceBrand: undefined,
      attach: () => {},
      resolverOf: () => {
        throw new Error('unexpected media resolve');
      },
    } as unknown as ISessionMediaService);
    ix.stub(ISessionTowerService, {
      _serviceBrand: undefined,
      attach: () => {},
      of: () => ({ isActive: false, enter: async () => {}, exit: () => {} }),
    } as unknown as ISessionTowerService);
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
    ix.stub(ISessionInstructionsProvider, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      agentsMd: undefined,
      agentsMdWarning: undefined,
      agentsMdPaths: undefined,
      onDidChange: Event.None as ISessionInstructionsProvider['onDidChange'],
    } satisfies ISessionInstructionsProvider);
    ix.stub(ISessionMcpHandle, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      connectionManager: new McpConnectionManager({
        log: noopLog,
        oauthService: new McpOAuthService({ store: createMcpOAuthStore(atomicDocsStore) }),
      }),
      isBaselineServer: () => true,
    } satisfies ISessionMcpHandle);
    stopAllOnExit = vi.fn(async (_reason: string) => [] as AgentTaskInfo[]);
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-task',
      new Ledger('test-task'),
      stubTaskRuntimeProvider(() => ({ stopAllOnExit })),
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-full-compaction',
      new Ledger('test-full-compaction'),
      stubFullCompactionRuntimeProvider(() =>
        stubFullCompactionRuntime({ cancel: () => stubFullCompactionCancel() }),
      ),
    );
    withdrawStubToolExecutor = ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-stub-tool-executor',
      new Ledger('test-stub-tool-executor'),
      stubAgentToolsRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-prompt',
      new Ledger('test-prompt'),
      promptAgentRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-reminder',
      new Ledger('test-reminder'),
      reminderAgentRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-context-memory',
      new Ledger('test-context-memory'),
      contextMemoryAgentRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-permission-mode',
      new Ledger('test-permission-mode'),
      permissionModeAgentRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-profile',
      new Ledger('test-profile'),
      profileAgentRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-loop',
      new Ledger('test-loop'),
      stubAgentLoopRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-undo',
      new Ledger('test-undo'),
      undoAgentRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-interaction',
      new Ledger('test-interaction'),
      interactionAgentRuntimeProvider,
    );
    const hostServiceType = class extends AgentHostService {
      override create(input: AgentHostCreateInput): AgentHost {
        registerLoopControl(input.scopeContext.agentContext, loopControl, () => ({ nextTurnId: 0, cancelledTurnIds: [] }));
        return super.create(input);
      }
    };
    ix.set(IAgentHostService, new SyncDescriptor(hostServiceType));
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

  it('create / get / list / remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    expect(main.agentId).toBe('main');
    expect(svc.get('main')).toBe(main);
    expect(svc.get('main')).toBeDefined();
    expect(svc.list()).toEqual([main]);
    await svc.remove(main);
    expect(svc.get('main')).toBeUndefined();
    expect(svc.get('main')).toBeUndefined();
  });

  it('remove keeps the lifecycle context active through async host teardown', async () => {
    let releaseDrain!: () => void;
    let gateEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      gateEntered = resolve;
    });
    const svc = ix.get(IAgentLifecycleService);
    const bus = ix.get(ISessionEventBus);
    const main = await svc.create({ agentId: 'main' });
    const seen: string[] = [];
    disposables.add(bus.subscribe(AgentActivityUpdated, (event) => seen.push(event.lifecycle)));
    promptDrain = vi.fn<PromptRuntime['drain']>(async () => {});
    vi.spyOn(svc.resolve(main, AgentPrompt), 'drain').mockImplementation(() => {
      gateEntered();
      return new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const removal = svc.remove(main);
      await entered;
      bus.publish(
        new AgentActivityUpdated({ lifecycle: 'disposed', background: [], agentId: 'main' }),
        main,
      );
      expect(seen).toEqual(['disposed']);
      releaseDrain();
      await removal;
      expect(() => {
        bus.publish(
          new AgentActivityUpdated({ lifecycle: 'disposed', background: [], agentId: 'main' }),
          main,
        );
      }).toThrow("Agent event 'agent.activity.updated' has no active lifecycle context");
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('remove stops the agent background tasks before disposal', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    promptDrain = vi.fn<PromptRuntime['drain']>(async () => {});
    vi.spyOn(svc.resolve(main, AgentPrompt), 'drain').mockImplementation(promptDrain);

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
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    promptDrain = vi.fn<PromptRuntime['drain']>(async () => {});
    vi.spyOn(svc.resolve(main, AgentPrompt), 'drain').mockImplementation(() => {
      markDrainStarted();
      return new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
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
    stubFullCompactionCancel = async () => {
      abortController.abort();
      await promise.catch(() => undefined);
    };
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
    ix.stub(IAgentRuntimeService, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
    } as unknown as IAgentRuntimeService);
    ix.stub(IGitService, {} as unknown as IGitService);
    ix.stub(IAgentToolContributionSource, {
      view: { items: [], onDidChange: () => ({ dispose: () => {} }) },
      providers: { items: [], onDidChange: () => ({ dispose: () => {} }) },
    } as never);
    withdrawStubToolExecutor();
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-tool-executor',
      new Ledger('test-tool-executor'),
      agentToolsRuntimeProvider,
    );
    ix.fiberHost.addCollectionRecord(
      AgentRuntimeContributionPoint,
      'test-permission-rules',
      new Ledger('test-permission-rules'),
      permissionRulesAgentRuntimeProvider,
    );
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const runtime: AgentToolsRuntime = svc.resolve(main, AgentTools);
    const domain = (runtime as unknown as { domain: ToolExecutorDomain }).domain;
    const makeCtx = (id: string): ResolvedToolExecutionHookContext => {
      const toolCall = {
        type: 'function' as const,
        id,
        name: 'Read',
        arguments: JSON.stringify({ path: '/a' }),
      };
      return {
        turnId: 0,
        signal: new AbortController().signal,
        toolCall,
        toolCalls: [toolCall],
        args: { path: '/a' },
        execution: { approvalRule: 'Read', execute: async () => ({ output: '' }) },
      };
    };
    const first = await domain.pipeline.beforeExecuteBus.fireBeforeExecute(makeCtx('c1'));
    const second = await domain.pipeline.beforeExecuteBus.fireBeforeExecute(makeCtx('c2'));
    expect(first).toBeUndefined();
    expect(second?.veto).toBeDefined();
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
    const main = await svc.create({ agentId: 'main' });
    const sub = await svc.create({});

    ix.get(IAgentHostService).of(main).telemetry.track2('yolo_toggle', { enabled: true });
    ix.get(IAgentHostService).of(sub).telemetry.track2('yolo_toggle', { enabled: false });

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

    const child = await svc.create({ agentId: 'child' });
    expect(svc.resolve(child, AgentPermissionMode).configured()).toBe(false);
    expect(svc.resolve(child, AgentPermissionMode).mode()).toBe('default');
  });

  it('applies the configured permission mode when the Agent has no persisted mode', async () => {
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => 'auto') as IConfigService['get'],
      onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
      onDidChangeConfiguration: (() => ({ dispose: () => {} })) as unknown as IConfigService['onDidChangeConfiguration'],
    } as unknown as IConfigService);

    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    expect(svc.resolve(main, AgentPermissionMode).mode()).toBe('auto');
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
      onDidChangeConfiguration: (() => ({ dispose: () => {} })) as unknown as IConfigService['onDidChangeConfiguration'],
    } as unknown as IConfigService);

    const main = await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    const svc = ix.get(IAgentLifecycleService);
    expect(svc.resolve(main, AgentPermissionMode).mode()).toBe('default');
  });

  it('restores the runtime binding without persisting a generation', async () => {
    ix.stub(IAppendLogStore, recordingAppendLog([
      createWireMetadataRecord(1),
      { type: 'runtime.set_binding', workspaceId: 'ws_test', runtimeId: 'remote', time: 2 },
    ]).store);

    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const agent = svc.get('main')!;

    expect(ix.get(IAgentHostService).of(agent).runtimeBinding.current).toEqual({
      workspaceId: 'ws_test',
      runtimeId: 'remote',
    });
    expect(ix.get(IAgentHostService).of(agent).agentRuntime.inspect().identity.generation).toBe('remote-one');
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
      onDidChangeConfiguration: (() => ({ dispose: () => {} })) as unknown as IConfigService['onDidChangeConfiguration'],
    } as unknown as IConfigService);
    ix.stub(ICronCreateTool, { _serviceBrand: undefined });
    ix.stub(ICronListTool, { _serviceBrand: undefined });
    ix.stub(ICronDeleteTool, { _serviceBrand: undefined });
    contributeTodo();
    contributeCron();

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
      onDidChangeConfiguration: (() => ({ dispose: () => {} })) as unknown as IConfigService['onDidChangeConfiguration'],
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
    const main = await svc.create({ agentId: 'main' });
    const child = await svc.create({ agentId: 'child' });

    svc.broadcastPermissionMode('yolo');

    expect(svc.resolve(main, AgentPermissionMode).mode()).toBe('dangerous');
    expect(svc.resolve(child, AgentPermissionMode).mode()).toBe('dangerous');
  });

  it('broadcastPermissionMode skips agents that have been removed', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const child = await svc.create({ agentId: 'child' });
    await svc.remove(child);

    svc.broadcastPermissionMode('auto');

    expect(svc.resolve(main, AgentPermissionMode).mode()).toBe('auto');
  });

  it('broadcastPermissionMode leaves tower-worker agents pinned to their spawned mode', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const worker = await svc.create({ agentId: 'worker-1' });
    void ix.get(IAgentHostService).of(worker).dispatcher.dispatch(
      new ProfileBind({
        agentId: 'worker-1',
        profileName: TOWER_WORKER_PROFILE,
        thinkingEffort: 'off',
        systemPrompt: '',
        disallowedTools: [],
      }),
    );

    svc.broadcastPermissionMode('yolo');

    expect(svc.resolve(main, AgentPermissionMode).mode()).toBe('dangerous');
    expect(svc.resolve(worker, AgentPermissionMode).mode()).toBe('default');
  });

  it('exposes the session MCP handle without moving OAuth ownership into the agent', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    const handle = ix.get(ISessionMcpHandle);
    expect(handle.connectionManager).toBeDefined();
    expect(handle.ready).toBeInstanceOf(Promise);
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

    const early = svc.get('main');
    expect(early).toBeDefined();

    const joined = svc.create({ agentId: 'main' });
    await registerCalled;
    releaseRegister();
    const handle = await joined;
    const created = await create;
    expect(handle).toBe(created);
    expect(svc.get('main')).toBe(early);
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
    expect(svc.get('main')).toBeUndefined();

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
    svc.resolve(source, AgentProfile).applyData({
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      subagents: ['explore'],
    });

    const child = await svc.fork(source, { agentId: 'forked' });

    expect(svc.resolve(child, AgentProfile).data()).toMatchObject({
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
    const sourceRuntime = ix.get(IAgentHostService).of(source).runtimeBinding;
    sourceRuntime.switch('remote');

    const child = await svc.fork(source, { agentId: 'forked-runtime' });
    const childRuntime = ix.get(IAgentHostService).of(child).runtimeBinding;
    expect(childRuntime.current.runtimeId).toBe('remote');

    sourceRuntime.switch('local');
    expect(childRuntime.current.runtimeId).toBe('remote');
    childRuntime.switch('local');
    expect(sourceRuntime.current.runtimeId).toBe('local');
  });

  it('fork seeds the child context, closing the trailing open tool exchange', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    const sourceHandle = svc.get('main')!;
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
    void svc.resolve(sourceHandle, AgentContextMemory).append(...history);

    const child = await svc.fork(sourceHandle, { agentId: 'forked' });

    const seeded = svc.resolve(child, AgentContextMemory).get();
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

    const child = await svc.fork(svc.get(source.agentId)!, { agentId: 'forked' });

    expect(
      svc.resolve(child, AgentContextMemory).get(),
    ).toEqual([]);
  });

  it('fork passes labels through to the registered agent metadata', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });

    await svc.fork(svc.get(source.agentId)!, {
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
    ).toThrow('Caller agent "missing" does not exist');
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
    };

    expect(() => svc.resolve(forged, AgentTodo)).toThrow('is not a lifecycle-issued context');
    expect(() => svc.inspect(forged)).toThrow('is not a lifecycle-issued context');

    await svc.remove(main);
    expect(() => svc.resolve(main, AgentTodo)).toThrow('is not a lifecycle-issued context');
  });

  it('retires agent runtimes before disposing the agent scope on remove', async () => {
    const order: string[] = [];
    contributeTodo();
    const svc = ix.get(IAgentLifecycleService);
    const willClose: string[] = [];
    disposables.add(svc.onWillClose((agent) => willClose.push(agent.agentId)));
    const main = await svc.create({ agentId: 'main' });
    svc.get('main');
    const bundle = ix.get(IAgentHostService).of(main);
    const originalDispose = bundle.dispose.bind(bundle);
    bundle.dispose = async () => {
      order.push('scope-disposed');
      await originalDispose();
    };
    svc.resolve(main, AgentTodo).get();

    await svc.remove(main);

    expect(willClose).toEqual(['main']);
    expect(order).toEqual(['scope-disposed']);
    expect(svc.get('main')).toBeUndefined();
  });

  it('rejects a durable participant attached after restore started', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const dispatcher = ix.get(IAgentHostService).of(main).dispatcher;

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
    const withdraw = contributeTodo();
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    svc.resolve(main, AgentTodo).get();

    withdraw();

    expect(() => svc.resolve(main, AgentTodo)).toThrow('unavailable');
    expect(svc.inspect(main).contributions.find((entry) => entry.id === 'todo')).toMatchObject({
      id: 'todo',
      status: 'retired',
    });
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
