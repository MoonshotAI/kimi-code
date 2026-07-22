/**
 * Scenario: session-owned agent creation, persistence, and MCP readiness.
 *
 * Exercises `AgentLifecycleService` through its DI contract with controlled
 * persistence and MCP boundaries, including completion ordering.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/agentLifecycle/agentLifecycle.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { type ISessionScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { type McpServerConfig } from '#/agent/mcp/config-schema';
import { IAgentProfileService } from '#/agent/profile/profile';
import '#/agent/profile/profileService';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import '#/agent/permissionMode/permissionModeOps';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { SessionMcpService } from '#/session/mcp/sessionMcpService';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import '#/agent/mcp/mcpService';
import '#/wire/wireService';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import '#/agent/toolDedupe/toolDedupeService';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
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
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { _clearToolContributionsForTests } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

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
  let beforeExecuteListeners: number;
  let didExecuteHookIds: string[];

  beforeEach(() => {
    _clearToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
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
      agentScope: (_ws: string, _session: string, agentId: string) =>
        `test/agents/${agentId}`,
      agentHomedir: (workspaceId: string, sessionId: string, agentId: string) =>
        `/tmp/kimi-agentLifecycle-home/sessions/${workspaceId}/${sessionId}/agents/${agentId}`,
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
    ix.stub(IAtomicDocumentStore, {
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
    } satisfies IAtomicDocumentStore);
    ix.stub(ILogService, noopLog);
    ix.stub(IAgentPluginService, {
      _serviceBrand: undefined,
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
    permissionModeSetMode = vi.fn();
    ix.stub(IAgentPermissionModeService, {
      _serviceBrand: undefined,
      mode: 'manual',
      setMode: permissionModeSetMode,
      onDidChangeMode: Event.None,
    } as unknown as IAgentPermissionModeService);
    ix.set(ISessionMcpService, new SyncDescriptor(SessionMcpService));
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

  it('create / getHandle / list / remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    expect(main.id).toBe('main');
    expect(svc.get('main')).toBe(main);
    expect(svc.list()).toEqual([main]);
    await svc.remove('main');
    expect(svc.get('main')).toBeUndefined();
  });

  it('remove stops the agent background tasks before disposal', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    await svc.remove('main');

    expect(stopAllOnExit).toHaveBeenCalledWith('Session closed');
  });

  it('remove cancels queued turns before waiting for the active turn to settle', async () => {
    loopActiveTurnId = 1;
    loopPendingTurnIds = [2, 3];
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });

    await svc.remove('main');

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
    await svc.create({ agentId: 'main' });

    let removed = false;
    const removal = svc.remove('main').then(() => {
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
    expect(first.id).toBe('agent-2');

    const second = await svc.create({});
    expect(second.id).toBe('agent-3');
  });

  it('seeds each agent scope with a telemetry view bound to its own agent id', async () => {
    const records: TelemetryRecord[] = [];
    ix.stub(ITelemetryService, recordingTelemetry(records));
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
    const sub = await svc.create({});

    main.accessor.get(ITelemetryService).track2('yolo_toggle', { enabled: true });
    sub.accessor.get(ITelemetryService).track2('yolo_toggle', { enabled: false });

    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: 'main', enabled: true },
    });
    expect(records).toContainEqual({
      event: 'yolo_toggle',
      properties: { agent_id: sub.id, enabled: false },
    });
  });

  it('create assigns sequential ids when unspecified', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const a = await svc.create({});
    const b = await svc.create({});
    expect(a.id).not.toBe(b.id);
  });

  it('persists complete agent metadata when creating a child', async () => {
    const svc = ix.get(IAgentLifecycleService);

    const child = await svc.create({
      agentId: 'child',
      forkedFrom: 'main',
      labels: { swarmItem: 'swarm-item-1' },
    });

    expect(child.id).toBe('child');
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

    await ix.get(IAgentLifecycleService).create({ agentId: 'main' });

    expect(permissionModeSetMode).toHaveBeenCalledOnce();
    expect(permissionModeSetMode).toHaveBeenCalledWith('auto');
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

  it('broadcastPermissionMode sets the mode on every live agent', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    await svc.create({ agentId: 'child' });

    svc.broadcastPermissionMode('yolo');

    expect(permissionModeSetMode.mock.calls).toEqual([['yolo'], ['yolo']]);
  });

  it('broadcastPermissionMode skips agents that have been removed', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    await svc.create({ agentId: 'child' });
    await svc.remove('child');

    svc.broadcastPermissionMode('auto');

    expect(permissionModeSetMode.mock.calls).toEqual([['auto']]);
  });

  it('wires MCP OAuth credentials through the session atomic document store', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });

    const mcp = main.accessor.get(IAgentMcpService);
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
        { access_token: 'session-token', token_type: 'Bearer' },
      ],
    ]);
  });

  it('waits for MCP config resolution and initial connect before returning an agent', async () => {
    let resolvePluginServersRequested!: () => void;
    const pluginServersRequested = new Promise<void>((resolve) => {
      resolvePluginServersRequested = resolve;
    });
    let resolvePluginServers:
      | ((servers: Record<string, McpServerConfig>) => void)
      | undefined;
    const pluginServers = new Promise<Record<string, McpServerConfig>>((resolve) => {
      resolvePluginServers = resolve;
    });
    ix.stub(IPluginService, {
      ...pluginServiceStub,
      enabledMcpServers: () => {
        resolvePluginServersRequested();
        return pluginServers;
      },
    } as unknown as IPluginService);

    let resolveConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      resolveConnectStarted = resolve;
    });
    let resolveConnect: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockImplementation(() => {
        resolveConnectStarted();
        return connected;
      });

    const svc = ix.get(IAgentLifecycleService);
    let settled = false;
    const create = svc.create({ agentId: 'main' }).then(() => {
      settled = true;
    });

    await pluginServersRequested;
    expect(settled).toBe(false);
    expect(connectAll).not.toHaveBeenCalled();

    resolvePluginServers?.({
      delayed: { transport: 'stdio', command: process.execPath },
    });
    await connectStarted;
    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveConnect?.();
    await create;
    expect(settled).toBe(true);
  });

  it('merges caller-supplied MCP servers into the initial connect (file < caller < plugin)', async () => {
    ix.stub(IPluginService, {
      ...pluginServiceStub,
      enabledMcpServers: async () => ({
        shared: { transport: 'stdio', command: 'plugin-version' },
      }),
    } as unknown as IPluginService);
    const connectAll = vi
      .spyOn(McpConnectionManager.prototype, 'connectAll')
      .mockResolvedValue(undefined);

    const sessionMcp = ix.get(ISessionMcpService);
    await sessionMcp.ensureMcpReady({
      shared: { transport: 'stdio', command: 'caller-version' },
      callerOnly: { transport: 'http', url: 'https://caller.example.com' },
    });

    expect(connectAll).toHaveBeenCalledTimes(1);
    expect(connectAll).toHaveBeenCalledWith({
      shared: { transport: 'stdio', command: 'plugin-version' },
      callerOnly: { transport: 'http', url: 'https://caller.example.com' },
    });

    await sessionMcp.ensureMcpReady({ ignored: { transport: 'stdio', command: 'ignored' } });
    expect(connectAll).toHaveBeenCalledTimes(1);
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
    // doCreate awaits the wire-log seal before registerAgent, so the mock is
    // invoked a few microtasks after create() — wait for the actual call.
    await registerCalled;
    releaseRegister();
    const handle = await joined;
    await create;
    expect(handle).toBe(early);
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

    const main = await svc.create({ agentId: 'main' });
    expect(main.id).toBe('main');
  });

  it('fork throws when the source agent does not exist', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await expect(svc.fork('missing')).rejects.toThrow('Source agent "missing" does not exist');
  });

  it('fork copies the bound profile snapshot without catalog resolution', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const source = await svc.create({ agentId: 'main' });
    source.accessor.get(IAgentProfileService).applyBindingSnapshot({
      cwd: '/work',
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      subagents: ['explore'],
    });

    const child = await svc.fork('main', { agentId: 'forked' });

    expect(child.accessor.get(IAgentProfileService).data()).toMatchObject({
      cwd: '/work',
      profileName: 'deleted-profile',
      thinkingLevel: 'high',
      systemPrompt: 'original prompt',
      activeToolNames: ['Read'],
      disallowedTools: ['Bash'],
      subagents: ['explore'],
    });
  });

  it('run throws when the agent does not exist', () => {
    ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
    const svc = ix.get(ISessionSubagentService);
    expect(() =>
      svc.run('missing', { kind: 'prompt', prompt: 'hi' }, { signal: new AbortController().signal }),
    ).toThrow('Agent "missing" does not exist');
  });

  it('fires onDidCreate on create and onDidDispose on remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const created: string[] = [];
    const disposed: string[] = [];
    disposables.add(svc.onDidCreate((h) => created.push(h.id)));
    disposables.add(svc.onDidDispose((id) => disposed.push(id)));

    const a = await svc.create({});
    expect(created).toEqual([a.id]);

    await svc.remove(a.id);
    expect(disposed).toEqual([a.id]);
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
