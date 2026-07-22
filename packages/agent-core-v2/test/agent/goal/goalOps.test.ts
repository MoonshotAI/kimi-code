/**
 * Scenario: wire-backed goal lifecycle persistence and replay.
 * Responsibilities: verify goal Ops, live events, and replay normalization through the service contract.
 * Wiring: real goal/wire/event/deadline services with non-persistence collaborators stubbed.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/goal/goalOps.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { Event } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IGoalDeadlineScheduler } from '#/agent/goal/goalDeadlineScheduler';
import { GoalDeadlineSchedulerService } from '#/agent/goal/goalDeadlineSchedulerService';
import { AgentGoalService } from '#/agent/goal/goalService';
import { GoalModel } from '#/agent/goal/goalOps';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

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
    onBeforeExecuteTool: Event.None,
    onWillExecuteTool: Event.None,
    hooks: { onDidExecuteTool: hookSlot() },
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
  ix.set(IGoalDeadlineScheduler, new SyncDescriptor(GoalDeadlineSchedulerService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  ix.stub(IAgentScopeContext, {
    _serviceBrand: undefined,
    agentId: 'main',
    scope: () => 'wire/agents/main',
  });
  ix.set(IAgentGoalService, new SyncDescriptor(AgentGoalService));
  return {
    wire,
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

async function readRecords(key = KEY): Promise<WireRecord[]> {
  await wire.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
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

  it('goal.updated is live-only and silent on replay', async () => {
    const signals: string[] = [];
    const sub = eventBus.subscribe((e) => {
      if (e.type === 'goal.updated') {
        signals.push(e.type);
      }
    });
    await svc.createGoal({ objective: 'work' });
    await svc.pauseGoal();
    expect(signals.length).toBeGreaterThanOrEqual(2);
    sub.dispose();

    const records = await readRecords();
    const host = buildHost('goal-replay');
    const replaySignals: string[] = [];
    host.eventBus.subscribe((e) => {
      if (e.type === 'goal.updated') {
        replaySignals.push(e.type);
      }
    });
    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'goal-replay'),
      records,
    );
    expect(modelOf(host.wire)?.status).toBe('paused');
    expect(replaySignals).toEqual([]);
  });

  it('onDidRestore forces a replayed active goal to paused after replay', async () => {
    const created = await svc.createGoal({ objective: 'resume me' });
    const records = await readRecords();

    const host = buildHost('goal-restore');
    void host.svc;

    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'goal-restore'),
      records,
    );
    expect(modelOf(host.wire)?.status).toBe('paused');
    expect(modelOf(host.wire)?.terminalReason).toBe('Paused after agent resume');
    expect(modelOf(host.wire)?.goalId).toBe(created.goalId);

    const written = await (async () => {
      const out: WireRecord[] = [];
      for await (const record of host.log.read<WireRecord>(
        testWireScope(SCOPE, 'goal-restore'),
        AGENT_WIRE_RECORD_KEY,
      )) {
        out.push(record);
      }
      return out;
    })();
    expect(written.filter((record) => record.type === 'goal.update')).toEqual([
      expect.objectContaining({
        type: 'goal.update',
        status: 'paused',
        reason: 'Paused after agent resume',
      }),
    ]);
  });

  it('restores goal records with omitted optional fields from older journals', async () => {
    await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
      { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
      { type: 'goal.update' },
    ]);

    expect(modelOf(wire)).toMatchObject({
      goalId: 'goal-1',
      status: 'paused',
      budgetLimits: {},
    });
  });

  it('restores legacy goal create audit fields without changing normalized state', async () => {
    await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'work',
        status: 'active',
        actor: 'user',
        budgetLimits: {},
      },
    ]);

    expect(modelOf(wire)).toMatchObject({
      goalId: 'goal-1',
      status: 'paused',
      budgetLimits: {},
    });
  });

  it('restores a legacy goal update identity without changing state selection', async () => {
    await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
      { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
      { type: 'goal.update', goalId: 'goal-1', status: 'blocked', reason: 'waiting' },
    ]);

    expect(modelOf(wire)).toMatchObject({
      goalId: 'goal-1',
      status: 'blocked',
      terminalReason: 'waiting',
    });
  });

  it('strips forward-compatible goal fields during restore', async () => {
    await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'work',
        futureField: true,
      },
    ]);

    expect(modelOf(wire)).toMatchObject({ goalId: 'goal-1', objective: 'work' });
  });

  it('skips a goal update with an invalid status during restore', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
        { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
        { type: 'goal.update', status: 'cancelled' },
      ]);

      expect(modelOf(wire)).toMatchObject({ status: 'paused' });
      expect(unexpected).toContainEqual(
        expect.objectContaining({ code: 'wire.unknown_record', details: { type: 'goal.update', index: 1 } }),
      );
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('skips a goal update with an invalid actor during restore', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
        { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
        { type: 'goal.update', actor: 'assistant' },
      ]);

      expect(modelOf(wire)).toMatchObject({ status: 'paused' });
      expect(unexpected).toContainEqual(
        expect.objectContaining({ code: 'wire.unknown_record', details: { type: 'goal.update', index: 1 } }),
      );
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('skips negative and non-finite goal counters and budgets during restore', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestAgentWire(wire, log, testWireScope(SCOPE, KEY), [
        { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
        { type: 'goal.update', turnsUsed: -1 },
        { type: 'goal.update', tokensUsed: Number.POSITIVE_INFINITY },
        { type: 'goal.update', wallClockMs: Number.NaN },
        { type: 'goal.update', wallClockResumedAt: Number.NaN },
        { type: 'goal.update', budgetLimits: { turnBudget: -1 } },
        { type: 'goal.update', budgetLimits: { tokenBudget: Number.POSITIVE_INFINITY } },
        { type: 'goal.update', budgetLimits: { wallClockBudgetMs: Number.NaN } },
      ]);

      expect(modelOf(wire)).toMatchObject({
        turnsUsed: 0,
        tokensUsed: 0,
        wallClockMs: 0,
        budgetLimits: {},
      });
      expect(unexpected).toHaveLength(7);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('skips null, arrays, and malformed nested goal records during restore', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestAgentWire(
        wire,
        log,
        testWireScope(SCOPE, KEY),
        [
          null,
          [],
          {
            type: 'goal.create',
            goalId: 'goal-1',
            objective: 'work',
            budgetLimits: { unexpected: true },
          },
        ] as unknown as WireRecord[],
      );

      expect(modelOf(wire)).toBeNull();
      expect(unexpected).toHaveLength(3);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});
