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
import { DisposableStore } from '#/_base/di/lifecycle';
import { type ISessionScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { type McpServerConfig } from '#/agent/mcp/config-schema';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { SessionMcpService } from '#/session/mcp/sessionMcpService';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import '#/activity/agentActivityService';
import '#/agent/mcp/mcpService';
import '#/agent/wireRecord/agentWireService';
import '#/agent/wireRecord/wireRecordService';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import '#/agent/toolDedupe/toolDedupeService';
import { IAgentActivityService, ISessionActivityKernel } from '#/activity/activity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { _clearToolContributionsForTests } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import { stubSessionActivityKernel } from '../../activity/stubs';

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

function recordingAppendLog(initial: readonly PersistedWireRecord[] = []): {
  readonly appended: PersistedWireRecord[];
  readonly store: IAppendLogStore;
  rewritten?: readonly PersistedWireRecord[];
} {
  const records = [...initial];
  const appended: PersistedWireRecord[] = [];
  const state: { rewritten?: readonly PersistedWireRecord[] } = {};
  const store: IAppendLogStore = {
    _serviceBrand: undefined,
    append: <R>(_scope: string, _key: string, record: R) => {
      const persisted = record as unknown as PersistedWireRecord;
      records.push(persisted);
      appended.push(persisted);
    },
    read: async function* <R>(): AsyncIterable<R> {
      for (const record of records) {
        yield record as R;
      }
    },
    rewrite: <R>(_scope: string, _key: string, next: readonly R[]) => {
      const persisted = next as readonly PersistedWireRecord[];
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
  let beforeExecuteHookIds: string[];
  let didExecuteHookIds: string[];

  beforeEach(() => {
    _clearToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAppendLogStore, recordingAppendLog().store);
    ix.stub(ISessionActivityKernel, stubSessionActivityKernel());
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
      agentHomedir: (_ws: string, _session: string, agentId: string) =>
        `/tmp/kimi-agentLifecycle-test/agents/${agentId}`,
      agentScope: (_ws: string, _session: string, agentId: string) =>
        `test/agents/${agentId}`,
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
    beforeExecuteHookIds = [];
    didExecuteHookIds = [];
    ix.stub(IAgentToolExecutorService, {
      _serviceBrand: undefined,
      hooks: {
        onBeforeExecuteTool: {
          register: (id: string) => {
            beforeExecuteHookIds.push(id);
            return { dispose: () => {} };
          },
        },
        onDidExecuteTool: {
          register: (id: string) => {
            didExecuteHookIds.push(id);
            return { dispose: () => {} };
          },
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
    } as unknown as IAgentLoopService);
    ix.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track2: () => {},
    } as unknown as ITelemetryService);
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

  it('ignites the self-wiring toolDedupe plugin so its hooks exist before the first turn', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await svc.create({ agentId: 'main' });
    expect(beforeExecuteHookIds).toContain('toolDedupe');
    expect(didExecuteHookIds).toContain('toolDedupe');
  });

  it('create assigns sequential ids when unspecified', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const a = await svc.create({});
    const b = await svc.create({});
    expect(a.id).not.toBe(b.id);
  });

  it('persists provenance and labels when creating an agent', async () => {
    const svc = ix.get(IAgentLifecycleService);

    const child = await svc.create({
      agentId: 'child',
      forkedFrom: 'main',
      labels: { swarmItem: 'swarm-item-1' },
    });

    expect(child.id).toBe('child');
    expect(registerAgent).toHaveBeenCalledWith('child', {
      homedir: '/tmp/kimi-agentLifecycle-test/agents/child',
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
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
  });

  it('does not re-seal a wire log that already has records', async () => {
    const existing: PersistedWireRecord = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'existing' }],
      origin: { kind: 'user' },
    } as unknown as PersistedWireRecord;
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

  it('exposes the in-flight handle and yields it idle after bootstrap', async () => {
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
    expect(early!.accessor.get(IAgentActivityService).lane()).toBe('initializing');

    const joined = svc.create({ agentId: 'main' });
    // doCreate awaits the wire-log seal before registerAgent, so the mock is
    // invoked a few microtasks after create() — wait for the actual call.
    await registerCalled;
    releaseRegister();
    const handle = await joined;
    await create;
    expect(handle).toBe(early);
    expect(handle!.accessor.get(IAgentActivityService).lane()).toBe('idle');
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
