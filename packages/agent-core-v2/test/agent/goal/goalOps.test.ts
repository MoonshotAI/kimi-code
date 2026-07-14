import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentGoalService } from '#/agent/goal/goal';
import { AgentGoalService } from '#/agent/goal/goalService';
import { GoalModel } from '#/agent/goal/goalOps';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'goal-test';

function noopDisposable(): { dispose: () => void } {
  return { dispose: () => undefined };
}

function hookSlot(): { register: () => { dispose: () => void } } {
  return { register: () => noopDisposable() };
}

function createLoopStub(): IAgentLoopService {
  return {
    _serviceBrand: undefined,
    hooks: { onWillBeginStep: hookSlot(), onDidFinishStep: hookSlot() },
  } as unknown as IAgentLoopService;
}

function createContextStub(): IAgentContextMemoryService {
  return {
    _serviceBrand: undefined,
    get: () => [],
    splice: () => undefined,
  } as unknown as IAgentContextMemoryService;
}

function createInjectorStub(): IAgentContextInjectorService {
  return {
    _serviceBrand: undefined,
    register: () => noopDisposable(),
  } as unknown as IAgentContextInjectorService;
}

function createRemindersStub(): IAgentSystemReminderService {
  return {
    _serviceBrand: undefined,
    appendSystemReminder: () => undefined,
  } as unknown as IAgentSystemReminderService;
}

function createTelemetryStub(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: () => undefined,
    track2: () => undefined,
  } as unknown as ITelemetryService;
}

function createToolExecutorStub(): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    hooks: { onBeforeExecuteTool: hookSlot(), onDidExecuteTool: hookSlot() },
  } as unknown as IAgentToolExecutorService;
}

function createConfigStub(): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as IConfigService;
}

let disposables: DisposableStore;
let wire: IWireService;
let svc: IAgentGoalService;
let log: IAppendLogStore;
let eventBus: IEventBus;

function buildHost(key: string): {
  wire: IWireService;
  svc: IAgentGoalService;
  log: IAppendLogStore;
  eventBus: IEventBus;
} {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: key }]));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.stub(IAgentLoopService, createLoopStub());
  ix.stub(IAgentUsageService, {
    onDidRecord: Event.None,
  } as unknown as IAgentUsageService);
  ix.stub(IAgentContextMemoryService, createContextStub());
  ix.stub(IAgentContextInjectorService, createInjectorStub());
  ix.stub(IAgentSystemReminderService, createRemindersStub());
  ix.stub(ITelemetryService, createTelemetryStub());
  ix.stub(IAgentToolExecutorService, createToolExecutorStub());
  ix.stub(IConfigService, createConfigStub());
  ix.set(IAgentGoalService, new SyncDescriptor(AgentGoalService, [{}]));
  return {
    wire: ix.get(IAgentWireService),
    svc: ix.get(IAgentGoalService),
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  wire = host.wire;
  svc = host.svc;
  log = host.log;
  eventBus = host.eventBus;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
    out.push(record);
  }
  return out;
}

function modelOf(target: IWireService) {
  return target.getModel(GoalModel);
}

describe('AgentGoalService (wire-backed)', () => {
  it('create/update persist flat records and getGoal reflects the model', async () => {
    const created = await svc.createGoal({ objective: 'Ship feature X' });
    expect(created.status).toBe('active');
    expect(modelOf(wire)?.goalId).toBe(created.goalId);
    expect(svc.getGoal().goal?.objective).toBe('Ship feature X');

    await svc.pauseGoal({ reason: 'break' });
    expect(modelOf(wire)?.status).toBe('paused');
    expect(svc.getGoal().goal?.status).toBe('paused');

    const records = await readRecords();
    expect(records).toEqual([
      expect.objectContaining({
        type: 'goal.create',
        goalId: created.goalId,
        objective: 'Ship feature X',
      }),
      expect.objectContaining({ type: 'goal.update', status: 'paused', reason: 'break' }),
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
  });

  it('clear persists a goal.clear record and empties the model', async () => {
    await svc.createGoal({ objective: 'work' });
    await svc.cancelGoal();
    expect(svc.getGoal().goal).toBeNull();
    expect(modelOf(wire)).toBeNull();

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual(['goal.create', 'goal.clear']);
  });

  it('goal.updated signal and model subscription are live-only and silent on replay', async () => {
    const signals: string[] = [];
    const sub = eventBus.subscribe((e) => {
      if (e.type === 'goal.updated') {
        signals.push(e.type);
      }
    });
    let modelChanges = 0;
    const modelSub = wire.subscribe(GoalModel, () => {
      modelChanges += 1;
    });

    await svc.createGoal({ objective: 'work' });
    await svc.pauseGoal();
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(modelChanges).toBeGreaterThanOrEqual(2);
    sub.dispose();
    modelSub.dispose();

    const records = await readRecords();
    const host = buildHost('goal-replay');
    const replaySignals: string[] = [];
    host.eventBus.subscribe((e) => {
      if (e.type === 'goal.updated') {
        replaySignals.push(e.type);
      }
    });
    let replayModelChanges = 0;
    host.wire.subscribe(GoalModel, () => {
      replayModelChanges += 1;
    });

    await host.wire.replay(...records);
    expect(modelOf(host.wire)?.status).toBe('paused');
    expect(replaySignals).toEqual([]);
    expect(replayModelChanges).toBe(0);
  });

  it('onRestored forces a replayed active goal to paused after replay', async () => {
    const created = await svc.createGoal({ objective: 'resume me' });
    const records = await readRecords();

    const host = buildHost('goal-restore');
    void host.svc;

    await host.wire.replay(...records);
    expect(modelOf(host.wire)?.status).toBe('paused');
    expect(modelOf(host.wire)?.terminalReason).toBe('Paused after agent resume');
    expect(modelOf(host.wire)?.goalId).toBe(created.goalId);

    const written = await (async () => {
      const out: PersistedRecord[] = [];
      for await (const record of host.log.read<PersistedRecord>(SCOPE, 'goal-restore')) {
        out.push(record);
      }
      return out;
    })();
    expect(written).toEqual([
      expect.objectContaining({
        type: 'goal.update',
        status: 'paused',
        reason: 'Paused after agent resume',
      }),
    ]);
  });
});
