import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'pathe';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import {
  createServices,
  type ServiceRegistration,
  type TestInstantiationService,
} from '#/_base/di/test';
import { LifecycleScope, type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { ILogService, type ILogService as LogService } from '#/_base/log/log';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionExportService } from '#/app/sessionExport/sessionExport';
import {
  exportSessionDirectory,
  SessionExportService,
} from '#/app/sessionExport/sessionExportService';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import {
  ISessionLifecycleService,
  type SessionLifecycleHooks,
} from '#/app/sessionLifecycle/sessionLifecycle';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';
import { Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const noopDisposable: IDisposable = { dispose: () => {} };
const noopEvent = () => noopDisposable;

describe('sessionExport', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('exports a v2 session directory with per-agent wire activity and optional global log', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_demo');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log'), '{"msg":"session"}\n', 'utf-8');
    await writeFile(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'metadata', time: 1_700_000_000_000 }),
        JSON.stringify({ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'hello' }),
      ].join('\n'),
      'utf-8',
    );
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    await mkdir(join(tmp, 'logs'), { recursive: true });
    await writeFile(globalLogPath, '{"msg":"global"}\n', 'utf-8');

    const outputPath = join(tmp, 'export.zip');
    const result = await exportSessionDirectory({
      request: {
        sessionId: 'ses_demo',
        outputPath,
        includeGlobalLog: true,
        version: '1.0.0-test',
      },
      summary: {
        id: 'ses_demo',
        title: 'Demo',
        workspaceDir: '/workspace/demo',
        sessionDir,
      },
      globalLogPath,
    });

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.entries).toEqual([
      'manifest.json',
      'agents/main/wire.jsonl',
      'logs/kimi-code.log',
      'state.json',
      'logs/global/kimi-code.log',
    ]);
    expect(result.manifest).toMatchObject({
      sessionId: 'ses_demo',
      kimiCodeVersion: '1.0.0-test',
      title: 'Demo',
      workspaceDir: '/workspace/demo',
      sessionFirstActivity: '2023-11-14T22:13:20.000Z',
      sessionLastActivity: '2023-11-14T22:13:25.000Z',
      sessionLogPath: 'logs/kimi-code.log',
      globalLogPath: 'logs/global/kimi-code.log',
    });
  });

  it('omits the optional global log when the configured path cannot be read', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_demo', 'ses_unreadable_global');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const globalLogPath = join(tmp, 'logs', 'kimi-code.log');
    await mkdir(globalLogPath, { recursive: true });

    const outputPath = join(tmp, 'unreadable-global.zip');
    const result = await exportSessionDirectory({
      request: {
        sessionId: 'ses_unreadable_global',
        outputPath,
        includeGlobalLog: true,
        version: '1.0.0-test',
      },
      summary: {
        id: 'ses_unreadable_global',
        workspaceDir: '/workspace/demo',
        sessionDir,
      },
      globalLogPath,
    });

    await expect(stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(result.manifest.globalLogPath).toBeUndefined();
    expect(result.entries).not.toContain('logs/global/kimi-code.log');
  });

  it('throws a coded error when the session is unknown', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    ix = createTestServices(tmp, {
      summary: undefined,
      lifecycleHandle: undefined,
    });

    await expect(
      ix.get(ISessionExportService).export({
        sessionId: 'ses_missing',
        version: '1.0.0-test',
      }),
    ).rejects.toMatchObject({
      name: 'Error2',
      code: 'session.not_found',
      details: { sessionId: 'ses_missing' },
    } satisfies Partial<Error2>);
  });

  it('flushes live session and agent state before packaging', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_live', 'ses_live');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const outputPath = join(tmp, 'live.zip');
    let sessionLogFlushes = 0;
    let agentWireFlushes = 0;
    const liveHandle = liveSessionHandle({
      meta: {
        id: 'ses_live',
        title: 'Fresh title',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      },
      sessionLog: {
        ...stubLog(),
        flush: async () => {
          sessionLogFlushes += 1;
        },
      },
      agentWire: {
        flush: async () => {
          agentWireFlushes += 1;
        },
      },
    });
    ix = createTestServices(tmp, {
      summary: {
        id: 'ses_live',
        workspaceId: 'ws_live',
        title: 'Stale title',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
      },
      lifecycleHandle: liveHandle,
    });

    const result = await ix.get(ISessionExportService).export({
      sessionId: 'ses_live',
      outputPath,
      version: '1.0.0-test',
    });

    expect(sessionLogFlushes).toBe(1);
    expect(agentWireFlushes).toBe(1);
    expect(result.manifest.title).toBe('Fresh title');
    expect(result.entries).toContain('state.json');
  });

  it('continues exporting when live flushes fail', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'session-export-test-'));
    const sessionDir = join(tmp, 'sessions', 'ws_live', 'ses_flush_failure');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), '{}\n', 'utf-8');
    const outputPath = join(tmp, 'flush-failure.zip');
    const warnings: string[] = [];
    const liveHandle = liveSessionHandle({
      meta: {
        id: 'ses_flush_failure',
        title: 'Fresh title',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      },
      sessionLog: {
        ...stubLog(),
        flush: async () => {
          throw new Error('session log flush failed');
        },
      },
      agentWire: {
        flush: async () => {
          throw new Error('agent wire flush failed');
        },
      },
    });
    ix = createTestServices(tmp, {
      summary: {
        id: 'ses_flush_failure',
        workspaceId: 'ws_live',
        title: 'Stale title',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
      },
      lifecycleHandle: liveHandle,
      appLog: {
        ...stubLog(),
        warn: (message) => {
          warnings.push(message);
        },
        flush: async () => {
          throw new Error('global log flush failed');
        },
      },
    });

    const result = await ix.get(ISessionExportService).export({
      sessionId: 'ses_flush_failure',
      outputPath,
      includeGlobalLog: true,
      version: '1.0.0-test',
    });

    expect(result.manifest.title).toBe('Fresh title');
    expect(result.entries).toContain('state.json');
    expect(result.manifest.globalLogPath).toBeUndefined();
    expect(warnings).toEqual([
      'export session log flush failed',
      'export agent wire flush failed',
      'export global log flush failed',
    ]);
  });

  function createTestServices(
    homeDir: string,
    options: {
      readonly summary: SessionSummary | undefined;
      readonly lifecycleHandle: ISessionScopeHandle | undefined;
      readonly appLog?: LogService;
    },
  ): TestInstantiationService {
    return createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerSessionExportServices(reg, homeDir, options);
      },
    });
  }
});

function registerSessionExportServices(
  reg: ServiceRegistration,
  homeDir: string,
  options: {
    readonly summary: SessionSummary | undefined;
    readonly lifecycleHandle: ISessionScopeHandle | undefined;
    readonly appLog?: LogService;
  },
): void {
  reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
  reg.defineInstance(ILogService, options.appLog ?? stubLog());
  reg.defineInstance(ISessionIndex, {
    _serviceBrand: undefined,
    list: async () => ({ items: options.summary === undefined ? [] : [options.summary] }),
    get: async () => options.summary,
    countActive: async () => (options.summary === undefined || options.summary.archived ? 0 : 1),
  });
  reg.defineInstance(ISessionLifecycleService, {
    _serviceBrand: undefined,
    onDidCreateSession: noopEvent,
    onDidCloseSession: noopEvent,
    onDidArchiveSession: noopEvent,
    onDidForkSession: noopEvent,
    hooks: createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
      'onDidCreateSession',
      'onWillCloseSession',
    ]),
    create: async () => {
      throw new Error('create should not be called by session export');
    },
    get: () => options.lifecycleHandle,
    list: () => (options.lifecycleHandle === undefined ? [] : [options.lifecycleHandle]),
    resume: async () => options.lifecycleHandle,
    close: async () => {},
    archive: async () => {},
    restore: async () => options.lifecycleHandle,
    fork: async () => {
      throw new Error('fork should not be called by session export');
    },
    createChild: async () => {
      throw new Error('createChild should not be called by session export');
    },
  });
  reg.defineInstance(IWorkspaceRegistry, {
    _serviceBrand: undefined,
    list: async () => [],
    get: async (id) => ({
      id,
      root: `/workspaces/${id}`,
      name: id,
      createdAt: 1,
      lastOpenedAt: 2,
    }),
    createOrTouch: async (root) => ({
      id: 'ws_created',
      root,
      name: 'created',
      createdAt: 1,
      lastOpenedAt: 2,
    }),
    update: async () => undefined,
    delete: async () => {},
  });
  reg.define(ISessionExportService, SessionExportService);
}

function liveSessionHandle(options: {
  readonly meta: SessionMeta;
  readonly sessionLog: LogService;
  readonly agentWire: Pick<ReturnType<typeof stubAgentWire>, 'flush'>;
}): ISessionScopeHandle {
  const agentHandle = testAgentHandle(options.agentWire);
  const lifecycle = stubAgentLifecycle([agentHandle]);
  return {
    id: options.meta.id,
    kind: LifecycleScope.Session,
    accessor: accessorFrom([
      [ISessionMetadata, stubSessionMetadata(options.meta)],
      [ILogService, options.sessionLog],
      [IAgentLifecycleService, lifecycle],
    ]),
    dispose: () => {},
  };
}

function testAgentHandle(agentWire: Pick<ReturnType<typeof stubAgentWire>, 'flush'>): IAgentScopeHandle {
  return {
    id: 'main',
    kind: LifecycleScope.Agent,
    accessor: accessorFrom([[IAgentWireRecordService, stubAgentWire(agentWire.flush)]]),
    dispose: () => {},
  };
}

function accessorFrom(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  const services = new Map<ServiceIdentifier<unknown>, unknown>(entries);
  return {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (!services.has(id as ServiceIdentifier<unknown>)) {
        throw new Error(`missing test service ${String(id)}`);
      }
      return services.get(id as ServiceIdentifier<unknown>) as T;
    },
  };
}

function stubSessionMetadata(meta: SessionMeta): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: noopEvent,
    read: async () => meta,
    update: async () => {},
    setTitle: async () => {},
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

function stubAgentLifecycle(agents: readonly IAgentScopeHandle[]): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: noopEvent,
    onDidCreate: noopEvent,
    onDidCreateMain: noopEvent,
    onDidDispose: noopEvent,
    create: async () => agents[0]!,
    ensureMcpReady: async () => {},
    notifyMainCreated: () => {},
    notifyAgentTaskStopped: () => {},
    fork: async () => agents[0]!,
    run: async () => {
      throw new Error('run should not be called by session export');
    },
    getHandle: (agentId) => agents.find((agent) => agent.id === agentId),
    whenReady: (agentId) => Promise.resolve(agents.find((agent) => agent.id === agentId)),
    list: () => agents,
    remove: async () => {},
  };
}

function stubAgentWire(flush: () => Promise<void> = async () => {}): IAgentWireRecordService {
  return {
    _serviceBrand: undefined,
    getRecords: () => [],
    restore: async () => ({}),
    flush,
    close: async () => {},
  };
}
