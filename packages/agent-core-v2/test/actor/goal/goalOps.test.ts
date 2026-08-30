import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { Event } from '#/_base/event';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import type { AgentRuntimeSet } from '#/actor/agentRuntimeSet';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createReminderStub, lifecycleWithReminder } from '../reminder/stubs';
import { AgentGoal, type GoalRuntime } from '#/actor/goal/goalAgentRuntime';
import { IGoalDeadlineScheduler } from '#/actor/goal/goalDeadlineScheduler';
import { GoalDeadlineSchedulerService } from '#/actor/goal/goalDeadlineSchedulerService';
import type { LoopControl } from '#/actor/loop/internal/loop';
import { getLoopControl, registerLoopControl } from '#/actor/loop/internal/access';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentHostService } from '#/agent/host/agentHost';
import { stubToolExecutorEvents } from '../toolExecutor/stubs';
import { lifecycleWithToolExecutor } from '../toolExecutor/stubs';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  attachGoalRuntime,
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher as restoreDispatcher,
  stubAgentScopeContext,
  testWireScope,
} from '../../wire/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

const SCOPE = 'wire';
const KEY = 'goal-test';

function noopDisposable(): { dispose: () => void } {
  return { dispose: () => undefined };
}

function hookSlot(): { register: () => { dispose: () => void } } {
  return { register: () => noopDisposable() };
}

function createLoopStub(): LoopControl {
  return {
    _serviceBrand: undefined,
    hooks: { onWillBeginStep: hookSlot(), onDidFinishStep: hookSlot() },
  } as unknown as LoopControl;
}

function createTelemetryStub(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: () => undefined,
    track2: () => undefined,
  } as unknown as ITelemetryService;
}

function createConfigStub(): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as IConfigService;
}

interface GoalHost {
  readonly dispatcher: IEventDispatcher;
  readonly runtimes: AgentRuntimeSet;
  readonly svc: GoalRuntime;
  readonly log: IAppendLogStore;
  readonly eventBus: IEventBus;
}

function inspectGoal(runtimes: AgentRuntimeSet): Record<string, unknown> | null {
  const line = runtimes.inspect().find((entry) => entry.id === 'goal');
  return (line?.state ?? null) as Record<string, unknown> | null;
}

let disposables: DisposableStore;
let dispatcher: IEventDispatcher;
let runtimes: AgentRuntimeSet;
let svc: GoalRuntime;
let log: IAppendLogStore;
let eventBus: IEventBus;

async function restoreGoalDispatcher(
  targetDispatcher: IEventDispatcher,
  targetLog: IAppendLogStore,
  scope: string,
  records: readonly WireRecord[],
  targetRuntimes = runtimes,
): Promise<void> {
  await restoreDispatcher(targetDispatcher, targetLog, scope, records);
  await targetRuntimes.restore();
}

function buildHost(key: string): GoalHost {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.stub(
    IAgentLifecycleService,
    lifecycleWithToolExecutor(stubToolExecutorEvents().executor, lifecycleWithReminder(createReminderStub())),
  );
  ix.stub(ITelemetryService, createTelemetryStub());
  ix.stub(IConfigService, createConfigStub());
  ix.stub(IAgentHostService, {
    _serviceBrand: undefined,
    of: () => ({
      eventBus: ix.get(IEventBus),
      telemetry: ix.get(ITelemetryService),
    }),
  } as unknown as IAgentHostService);
  ix.set(IGoalDeadlineScheduler, new SyncDescriptor(GoalDeadlineSchedulerService));
  const wireScope = stubAgentScopeContext(testWireScope(SCOPE, key));
  registerTestAgentWire(ix, wireScope, {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  const mainScopeContext: IAgentScopeContext = {
    _serviceBrand: undefined,
    agentId: 'main',
    agentContext: stubAgentContext('main', 1),
    scope: () => 'wire/agents/main',
  };
  registerLoopControl(mainScopeContext.agentContext, createLoopStub(), () => ({ nextTurnId: 0, cancelledTurnIds: [] }));
  (ix.get(IEventBus) as ISessionEventBus).activateAgent(mainScopeContext.agentContext);
  const dispatcher = registerTestEventDispatcher(ix, mainScopeContext);
  const runtimes = attachGoalRuntime(ix, dispatcher, mainScopeContext.agentContext);
  return {
    dispatcher,
    runtimes,
    svc: runtimes.resolve(AgentGoal),
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  dispatcher = host.dispatcher;
  runtimes = host.runtimes;
  svc = host.svc;
  log = host.log;
  eventBus = host.eventBus;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('goal runtime (wire-backed)', () => {
  it('create/update persist flat records and getGoal reflects the state', async () => {
    const created = await svc.createGoal({ objective: 'Ship feature X' });
    expect(created.status).toBe('active');
    expect(inspectGoal(runtimes)?.['goalId']).toBe(created.goalId);
    expect(svc.getGoal().goal?.objective).toBe('Ship feature X');

    await svc.pauseGoal({ reason: 'break' });
    expect(inspectGoal(runtimes)?.['status']).toBe('paused');
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

  it('clear persists a goal.clear record and empties the state', async () => {
    await svc.createGoal({ objective: 'work' });
    await svc.cancelGoal();
    expect(svc.getGoal().goal).toBeNull();
    expect(inspectGoal(runtimes)).toBeNull();

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
    await restoreGoalDispatcher(
      host.dispatcher,
      host.log,
      testWireScope(SCOPE, 'goal-replay'),
      records,
      host.runtimes,
    );
    expect(inspectGoal(host.runtimes)?.['status']).toBe('paused');
    expect(replaySignals).toEqual([]);
  });

  it('onDidRestore forces a replayed active goal to paused after replay', async () => {
    const created = await svc.createGoal({ objective: 'resume me' });
    const records = await readRecords();

    const host = buildHost('goal-restore');
    void host.svc;

    await restoreGoalDispatcher(
      host.dispatcher,
      host.log,
      testWireScope(SCOPE, 'goal-restore'),
      records,
      host.runtimes,
    );
    expect(inspectGoal(host.runtimes)?.['status']).toBe('paused');
    expect(inspectGoal(host.runtimes)?.['terminalReason']).toBe('Paused after agent resume');
    expect(inspectGoal(host.runtimes)?.['goalId']).toBe(created.goalId);

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
    await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
      { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
      { type: 'goal.update' },
    ]);

    expect(inspectGoal(runtimes)).toMatchObject({
      goalId: 'goal-1',
      status: 'paused',
      budgetLimits: {},
    });
  });

  it('restores legacy goal create audit fields without changing normalized state', async () => {
    await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'work',
        status: 'active',
        actor: 'user',
        budgetLimits: {},
      },
    ]);

    expect(inspectGoal(runtimes)).toMatchObject({
      goalId: 'goal-1',
      status: 'paused',
      budgetLimits: {},
    });
  });

  it('restores a legacy goal update identity without changing state selection', async () => {
    await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
      { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
      { type: 'goal.update', goalId: 'goal-1', status: 'blocked', reason: 'waiting' },
    ]);

    expect(inspectGoal(runtimes)).toMatchObject({
      goalId: 'goal-1',
      status: 'blocked',
      terminalReason: 'waiting',
    });
  });

  it('strips forward-compatible goal fields during restore', async () => {
    await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'work',
        futureField: true,
      },
    ]);

    expect(inspectGoal(runtimes)).toMatchObject({ goalId: 'goal-1', objective: 'work' });
  });

  it('skips a goal update with an invalid status during restore', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
        { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
        { type: 'goal.update', status: 'cancelled' },
      ]);

      expect(inspectGoal(runtimes)).toMatchObject({ status: 'paused' });
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
      await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
        { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
        { type: 'goal.update', actor: 'assistant' },
      ]);

      expect(inspectGoal(runtimes)).toMatchObject({ status: 'paused' });
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
      await restoreGoalDispatcher(dispatcher, log, testWireScope(SCOPE, KEY), [
        { type: 'goal.create', goalId: 'goal-1', objective: 'work' },
        { type: 'goal.update', turnsUsed: -1 },
        { type: 'goal.update', tokensUsed: Number.POSITIVE_INFINITY },
        { type: 'goal.update', wallClockMs: Number.NaN },
        { type: 'goal.update', wallClockResumedAt: Number.NaN },
        { type: 'goal.update', budgetLimits: { turnBudget: -1 } },
        { type: 'goal.update', budgetLimits: { tokenBudget: Number.POSITIVE_INFINITY } },
        { type: 'goal.update', budgetLimits: { wallClockBudgetMs: Number.NaN } },
      ]);

      expect(inspectGoal(runtimes)).toMatchObject({
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
      await restoreGoalDispatcher(
        dispatcher,
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

      expect(inspectGoal(runtimes)).toBeNull();
      expect(unexpected).toHaveLength(3);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});
