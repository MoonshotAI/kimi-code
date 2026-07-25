import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { AgentTaskInfo } from '#/agent/task/task';
import { TaskModel, taskStarted, taskTerminated } from '#/agent/task/taskOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'task-test';

let disposables: DisposableStore;
let wire: IWireService;
let log: IAppendLogStore;

function buildHost(key: string): { wire: IWireService; log: IAppendLogStore; eventBus: IEventBus } {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  return { wire, log: ix.get(IAppendLogStore), eventBus: ix.get(IEventBus) };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  wire = host.wire;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<WireRecord[]> {
  await wire.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

function info(taskId: string, status: AgentTaskInfo['status']): AgentTaskInfo {
  return {
    taskId,
    kind: 'process',
    description: `task ${taskId}`,
    status,
    detached: true,
    startedAt: 1000,
    endedAt: status === 'running' ? null : 2000,
  } as AgentTaskInfo;
}

describe('task ops (wire-backed)', () => {
  it('started/terminated fold into the task map by id and persist to the journal', async () => {
    expect(wire.getModel(TaskModel).size).toBe(0);

    wire.dispatch(taskStarted({ info: info('t1', 'running') }));
    expect(wire.getModel(TaskModel).get('t1')?.status).toBe('running');

    wire.dispatch(taskTerminated({ info: info('t1', 'completed') }));
    expect(wire.getModel(TaskModel).get('t1')?.status).toBe('completed');

    wire.dispatch(taskStarted({ info: info('t2', 'running') }));
    expect(wire.getModel(TaskModel).size).toBe(2);

    expect(await readRecords()).toEqual([
      { type: 'task.started', info: info('t1', 'running'), time: expect.any(Number) },
      { type: 'task.terminated', info: info('t1', 'completed'), time: expect.any(Number) },
      { type: 'task.started', info: info('t2', 'running'), time: expect.any(Number) },
    ]);
  });

  it('task.terminated persists the optional outputTail snapshot (fold-only, never in the model)', async () => {
    wire.dispatch(taskTerminated({ info: info('t1', 'completed'), outputTail: 'last lines' }));

    expect(await readRecords()).toEqual([
      {
        type: 'task.terminated',
        info: info('t1', 'completed'),
        outputTail: 'last lines',
        time: expect.any(Number),
      },
    ]);
    expect(wire.getModel(TaskModel).get('t1')).toEqual(info('t1', 'completed'));
  });

  it('apply returns a new Map on change (the model is the restore seed)', () => {
    const before = wire.getModel(TaskModel);
    wire.dispatch(taskStarted({ info: info('t1', 'running') }));
    const after = wire.getModel(TaskModel);
    expect(after).not.toBe(before);
    expect(after.get('t1')?.status).toBe('running');
  });

  it('replay rebuilds the task map from persisted task.* records silently', async () => {
    const records: WireRecord[] = [
      { type: 'task.started', info: info('t1', 'running') },
      { type: 'task.terminated', info: info('t1', 'completed'), outputTail: 'tail' },
      { type: 'task.started', info: info('t2', 'running') },
    ] as unknown as WireRecord[];

    const host = buildHost('task-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'task-replay'),
      records,
    );
    const model = host.wire.getModel(TaskModel);
    expect(model.size).toBe(2);
    expect(model.get('t1')?.status).toBe('completed');
    expect(model.get('t2')?.status).toBe('running');
    expect(emissions).toEqual([]);
  });
});
