import { PassThrough, type Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { Emitter, Event } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import { createScopedChildHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import type { ServicesAccessor, ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import type { MonitorOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentMonitorService } from '#/agent/monitor/monitor';
import { AgentMonitorService } from '#/agent/monitor/monitorService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTaskService, type AgentTask } from '#/agent/task/task';
import { AgentTaskService } from '#/agent/task/taskService';
import type { AgentTaskSink } from '#/agent/task/types';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { MonitorCreateInputSchema } from '#/agent/tools/monitor/monitor-create/monitor-create';
import '#/agent/tools/monitor/monitor-create/monitorCreateTool';
import '#/agent/tools/monitor/monitor-list/monitorListTool';
import '#/agent/tools/monitor/monitor-cancel/monitorCancelTool';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ITaskService } from '#/app/task/task';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  type HostFsChange,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IWireService } from '#/wire/wire';

import { stubLog } from '../../_base/log/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { stubContextMemory, type StubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, type StubLoop } from '../loop/stubs';

const TEST_CWD = '/tmp/monitor-test-session';

function stubWireService(): IWireService {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: () => {},
    readJournal: async function* () {},
    flush: async () => {},
  };
}

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function inMemoryDocs(): IAtomicDocumentStore {
  const data = new Map<string, unknown>();
  return {
    _serviceBrand: undefined,
    get: async (scope, key) => data.get(`${scope}/${key}`) as never,
    set: async (scope, key, value) => {
      data.set(`${scope}/${key}`, value);
    },
    delete: async (scope, key) => {
      data.delete(`${scope}/${key}`);
    },
    list: async (scope, prefix) =>
      [...data.keys()]
        .filter((key) => key.startsWith(`${scope}/`))
        .map((key) => key.slice(scope.length + 1))
        .filter((key) => prefix === undefined || key.startsWith(prefix)),
    watch: () => Event.None as Event<void>,
    acquire: () => toDisposable(() => {}),
  };
}

class FakeWatchHandle implements IHostFsWatchHandle {
  private readonly emitter = new Emitter<HostFsChange>();
  readonly onDidChange = this.emitter.event;
  readonly ready = Promise.resolve();
  disposed = false;

  fire(change: HostFsChange): void {
    this.emitter.fire(change);
  }

  dispose(): void {
    this.disposed = true;
    this.emitter.dispose();
  }
}

interface FakeWatchCall {
  readonly path: string;
  readonly options?: HostFsWatchOptions;
  readonly handle: FakeWatchHandle;
}

interface FakeProc {
  readonly proc: IHostProcess;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly killSignals: string[];
  settle(exitCode: number): void;
}

function makeFakeProc(): FakeProc {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killSignals: string[] = [];
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((done) => {
    resolveWait = done;
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    pid: 4321,
    get exitCode() {
      return null;
    },
    stdin: new PassThrough() as unknown as Writable,
    stdout,
    stderr,
    wait: () => waitPromise,
    kill: (signal) => {
      killSignals.push(signal ?? 'SIGTERM');
      return Promise.resolve();
    },
    dispose: () => {},
  };
  return {
    proc,
    stdout,
    stderr,
    killSignals,
    settle(exitCode: number) {
      stdout.end();
      stderr.end();
      resolveWait(exitCode);
    },
  };
}

interface ControllableTask {
  readonly task: AgentTask;
  appendOutput(chunk: string): void;
  settle(status: 'completed' | 'failed'): Promise<boolean>;
}

function controllableProcessTask(): ControllableTask {
  let sink: AgentTaskSink | undefined;
  const task: AgentTask = {
    idPrefix: 'test',
    kind: 'process',
    description: 'controllable fake task',
    start: (s) => {
      sink = s;
    },
    toInfo: (base) => ({ ...base, kind: 'process', command: 'fake', pid: 0, exitCode: null }),
  };
  return {
    task,
    appendOutput(chunk: string): void {
      sink?.appendOutput(chunk);
    },
    settle(status: 'completed' | 'failed'): Promise<boolean> {
      if (sink === undefined) return Promise.resolve(false);
      return sink.settle({ status });
    },
  };
}

describe('AgentMonitorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let eventBus: EventBusService;
  let watchCalls: FakeWatchCall[];
  let spawnedProcs: FakeProc[];
  let spawnError: Error | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    eventBus = disposables.add(new EventBusService());
    watchCalls = [];
    spawnedProcs = [];
    spawnError = undefined;
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentConversationUndoParticipantRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
    });
    ix.stub(IWireService, stubWireService());
    ix.stub(IEventBus, eventBus);
    ix.stub(IAgentContextInjectorService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(ITaskService, {
      run: () => {
        throw new Error('ITaskService.run is not used by this test');
      },
      defer: () => {
        throw new Error('ITaskService.defer is not used by this test');
      },
    });
    ix.stub(IAgentContextMemoryService, stubContextMemory(eventBus));
    ix.stub(ITelemetryService, { track: () => {}, track2: () => {} });
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(IConfigRegistry, { registerSection: () => {} });
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 'monitor-test-session',
        workspaceId: 'test-ws',
        sessionDir: TEST_CWD,
        sessionScope: 'sessions/test-ws/monitor-test-session',
        cwd: TEST_CWD,
      }),
    );
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId: 'main',
        agentScope: 'sessions/test-ws/monitor-test-session/agents/main',
      }),
    );
    ix.stub(IAtomicDocumentStore, inMemoryDocs());
    ix.stub(IFileSystemStorageService, {
      read: async () => undefined,
      readStream: async function* () {},
      write: async () => {},
      writeStream: async () => {},
      append: async () => {},
      list: async () => [],
      delete: async () => {},
      flush: async () => {},
      close: async () => {},
    });
    ix.stub(IAgentBlobService, noopBlob);
    ix.stub(IHostFsWatchService, {
      watch: (path: string, options?: HostFsWatchOptions) => {
        const handle = new FakeWatchHandle();
        watchCalls.push({ path, options, handle });
        return handle;
      },
    });
    ix.stub(IAgentRuntimeService, {
      onDidChange: Event.None,
      inspect: () => {
        throw new Error('inspect is not used by this test');
      },
      isAvailable: () => true,
      acquire: () => ({
        runtime: {
          environment: {
            osKind: 'Linux',
            osArch: 'x64',
            osVersion: 'test',
            shellName: 'sh',
            shellPath: '/bin/sh',
            pathClass: 'posix',
            homeDir: '/home/fake',
          },
          process: {
            spawn: () => {
              if (spawnError !== undefined) return Promise.reject(spawnError);
              const fake = makeFakeProc();
              spawnedProcs.push(fake);
              return Promise.resolve(fake.proc);
            },
          },
        },
        track: <T>(resource: T): T => resource,
        dispose: () => {},
      }),
    } as unknown as IAgentRuntimeService);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
    ix.set(IAgentMonitorService, new SyncDescriptor(AgentMonitorService));
  });
  afterEach(() => {
    disposables.dispose();
  });

  function monitors(): IAgentMonitorService {
    return ix.get(IAgentMonitorService);
  }

  function tasks(): IAgentTaskService {
    return ix.get(IAgentTaskService);
  }

  function stubLoop(): StubLoop {
    return ix.get(IAgentLoopService) as unknown as StubLoop;
  }

  function contextMessages() {
    return (ix.get(IAgentContextMemoryService) as StubContextMemory).messages;
  }

  function drainMonitorNotifications(): readonly MonitorOrigin[] {
    stubLoop().drainNextBatch(ix.get(IAgentContextMemoryService));
    return contextMessages()
      .map((message) => message.origin)
      .filter((origin): origin is MonitorOrigin => origin?.kind === 'monitor');
  }

  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('condition not met within timeout');
  }

  it('task_output monitor fires on a pattern match spanning chunk boundaries', async () => {
    const ctl = controllableProcessTask();
    const taskId = tasks().registerTask(ctl.task);
    await tick();
    const info = await monitors().createMonitor({
      type: 'task_output',
      taskId,
      pattern: 'ready',
      timeoutMs: 60_000,
    });

    ctl.appendOutput('server is re');
    expect(monitors().listMonitors()[0]?.status).toBe('active');
    ctl.appendOutput('ady on port 3000\nnext line\n');

    await waitFor(() => monitors().listMonitors()[0]?.status === 'fired');
    const fired = monitors().listMonitors()[0];
    expect(fired?.monitorId).toBe(info.monitorId);
    expect(fired?.trigger).toBe('match');

    const origins = drainMonitorNotifications();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      kind: 'monitor',
      monitorId: info.monitorId,
      monitorType: 'task_output',
      trigger: 'match',
    });
    const text = contextMessages()
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(text).toContain('Matched line: server is ready on port 3000');
  });

  it('monitor fires a timeout notification when the timeout elapses', async () => {
    const ctl = controllableProcessTask();
    const taskId = tasks().registerTask(ctl.task);
    await tick();
    const info = await monitors().createMonitor({
      type: 'task_output',
      taskId,
      pattern: 'never-matches',
      timeoutMs: 30,
    });

    await waitFor(() => monitors().listMonitors()[0]?.status === 'fired');
    expect(monitors().listMonitors()[0]?.trigger).toBe('timeout');

    const origins = drainMonitorNotifications();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({ monitorId: info.monitorId, trigger: 'timeout' });
  });

  it('cancel stops the monitor and suppresses any later notification', async () => {
    const ctl = controllableProcessTask();
    const taskId = tasks().registerTask(ctl.task);
    await tick();
    const info = await monitors().createMonitor({
      type: 'task_output',
      taskId,
      pattern: 'ready',
      timeoutMs: 60_000,
    });

    const cancelled = await monitors().cancelMonitor(info.monitorId);
    expect(cancelled?.status).toBe('cancelled');

    ctl.appendOutput('ready\n');
    await tick();
    expect(drainMonitorNotifications()).toHaveLength(0);
    expect(await monitors().cancelMonitor('monitor-missing')).toBeUndefined();
  });

  it('task_output monitor ends silently when the target task terminates without a match', async () => {
    const ctl = controllableProcessTask();
    const taskId = tasks().registerTask(ctl.task);
    await tick();
    await monitors().createMonitor({
      type: 'task_output',
      taskId,
      pattern: 'never-matches',
      timeoutMs: 60_000,
    });

    await ctl.settle('completed');

    await waitFor(() => monitors().listMonitors()[0]?.status === 'ended');
    expect(drainMonitorNotifications()).toHaveLength(0);
  });

  it('command monitor fires an exit notification when the command exits first', async () => {
    await monitors().createMonitor({
      type: 'command',
      command: 'tail -f app.log',
      pattern: 'never-matches',
      timeoutMs: 60_000,
    });
    expect(spawnedProcs).toHaveLength(1);

    spawnedProcs[0]!.settle(0);

    await waitFor(() => monitors().listMonitors()[0]?.status === 'fired');
    expect(monitors().listMonitors()[0]?.trigger).toBe('exit');

    const origins = drainMonitorNotifications();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({ monitorType: 'command', trigger: 'exit' });
    const text = contextMessages()
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(text).toContain('exited (code 0)');
  });

  it('command monitor terminates the command process after a pattern match', async () => {
    await monitors().createMonitor({
      type: 'command',
      command: 'tail -f app.log',
      pattern: 'ready',
      timeoutMs: 60_000,
    });
    expect(spawnedProcs).toHaveLength(1);
    const fake = spawnedProcs[0]!;
    await tick();

    fake.stdout.write('service ready\n');

    await waitFor(() => monitors().listMonitors()[0]?.status === 'fired');
    expect(monitors().listMonitors()[0]?.trigger).toBe('match');
    await waitFor(() => fake.killSignals.length > 0);
    expect(fake.killSignals).toContain('SIGTERM');
    fake.settle(0);

    const origins = drainMonitorNotifications();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({ monitorType: 'command', trigger: 'match' });
  });

  it('file monitor fires on a matching change and ignores deletions', async () => {
    const info = await monitors().createMonitor({
      type: 'file',
      path: 'logs/app.log',
      timeoutMs: 60_000,
    });
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0]?.path).toBe(`${TEST_CWD}/logs/app.log`);
    const handle = watchCalls[0]!.handle;

    handle.fire({ path: `${TEST_CWD}/logs/app.log`, action: 'deleted', kind: 'file' });
    await tick();
    expect(monitors().listMonitors()[0]?.status).toBe('active');

    handle.fire({ path: `${TEST_CWD}/logs/app.log`, action: 'modified', kind: 'file' });
    await waitFor(() => monitors().listMonitors()[0]?.status === 'fired');
    expect(monitors().listMonitors()[0]?.trigger).toBe('match');

    const origins = drainMonitorNotifications();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      monitorId: info.monitorId,
      monitorType: 'file',
      trigger: 'match',
    });
    expect(handle.disposed).toBe(true);
  });

  it('file monitor watches the static prefix of a glob and filters with picomatch', async () => {
    await monitors().createMonitor({
      type: 'file',
      path: 'reports/**/*.log',
      events: ['created'],
      timeoutMs: 60_000,
    });
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0]?.path).toBe(`${TEST_CWD}/reports`);
    expect(watchCalls[0]?.options?.recursive).toBe(true);
    const handle = watchCalls[0]!.handle;

    handle.fire({ path: `${TEST_CWD}/reports/summary.txt`, action: 'created', kind: 'file' });
    handle.fire({ path: `${TEST_CWD}/reports/deep/run.log`, action: 'modified', kind: 'file' });
    await tick();
    expect(monitors().listMonitors()[0]?.status).toBe('active');

    handle.fire({ path: `${TEST_CWD}/reports/deep/run.log`, action: 'created', kind: 'file' });
    await waitFor(() => monitors().listMonitors()[0]?.status === 'fired');
    expect(monitors().listMonitors()[0]?.trigger).toBe('match');
  });

  it('rejects invalid input at the schema boundary', () => {
    expect(
      MonitorCreateInputSchema.safeParse({ type: 'task_output', task_id: 'bash-123' }).success,
    ).toBe(false);
    expect(
      MonitorCreateInputSchema.safeParse({
        type: 'task_output',
        task_id: 'bash-123',
        pattern: 'x',
        timeout_s: 90_000,
      }).success,
    ).toBe(false);
    expect(
      MonitorCreateInputSchema.safeParse({ type: 'command', command: 'tail -f x.log' }).success,
    ).toBe(true);
    expect(
      MonitorCreateInputSchema.safeParse({
        type: 'file',
        path: 'dist/**',
        events: ['created'],
      }).success,
    ).toBe(true);
    expect(
      MonitorCreateInputSchema.safeParse({ type: 'file', path: 'dist/**', events: ['deleted'] })
        .success,
    ).toBe(false);
    expect(MonitorCreateInputSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('contributes replayable state keys before dispatcher restore in a real agent scope', async () => {
    ix.set(ISessionStateService, new SessionStateService());
    const handle = createScopedChildHandle(ix, LifecycleScope.Agent, 'main', {
      seeds: [
        [IWireService, stubWireService()],
        [
          IAgentRuntimeService,
          {
            _serviceBrand: undefined,
            onDidChange: Event.None,
            inspect: () => {
              throw new Error('inspect is not used by this test');
            },
            isAvailable: () => true,
            acquire: () => {
              throw new Error('acquire is not used by this test');
            },
          } as unknown as IAgentRuntimeService,
        ],
      ],
    });
    disposables.add(handle);
    await tick();

    const dispatcher = handle.accessor.get(IEventDispatcher);
    await dispatcher.restore();

    const monitor = handle.accessor.get(IAgentMonitorService);
    expect(monitor.listMonitors()).toEqual([]);
    const replayables = handle
      .accessor.get(IAgentStateService)
      .replayableKeys()
      .map((key) => key.name);
    expect(replayables).toContain('monitor.notificationDelivery');
  });

  it('tool contributions are gated by the monitor flag', () => {
    const contributions = getAgentToolContributions();
    const names = ['MonitorCreate', 'MonitorList', 'MonitorCancel'];
    const accessorWith = (flag: boolean): ServicesAccessor => {
      const stub = stubFlag(flag);
      return {
        get: <T>(id: ServiceIdentifier<T>): T => {
          if (id === (IFlagService as unknown as ServiceIdentifier<T>)) return stub as T;
          throw new Error('unexpected service resolution');
        },
      };
    };
    for (const name of names) {
      const contribution = contributions.find((entry) => entry.options.name === name);
      expect(contribution, `${name} contribution`).toBeDefined();
      expect(contribution?.options.domain).toBe('agentMonitor');
      expect(contribution?.options.when?.(accessorWith(false))).toBe(false);
      expect(contribution?.options.when?.(accessorWith(true))).toBe(true);
    }
  });
});
