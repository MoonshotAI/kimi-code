import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentModeMutexService } from '#/agent/modeMutex/modeMutex';
import { AgentModeMutexService } from '#/agent/modeMutex/modeMutexService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { GoalUpdated } from '#/features/goal/goalOps';
import { IAgentGoalService } from '#/features/goal/goalService';
import type { GoalSnapshot } from '#/features/goal/types';
import { IAgentPlanService } from '#/features/plan/plan';
import { planKey } from '#/features/plan/planOps';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { IAgentTowerService } from '#/features/tower/tower';
import { OrderedHookSlot } from '#/hooks';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { registerTestAgentWire, testWireScope } from '../../wire/stubs';

describe('AgentModeMutexService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let planExit: ReturnType<typeof vi.fn>;
  let swarmExit: ReturnType<typeof vi.fn>;
  let towerExit: ReturnType<typeof vi.fn>;
  let goalPause: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;
  let onDidRestore: OrderedHookSlot<Record<string, never>>;
  let swarmActive: boolean;
  let towerActive: boolean;
  let goalStatus: string | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentStateService, new AgentStateService());
    registerTestAgentWire(ix, testWireScope('wire', 'mode-mutex-test'), {
      eventBus: ix.get(IEventBus),
    });
    planExit = vi.fn();
    swarmExit = vi.fn();
    towerExit = vi.fn(async () => {});
    goalPause = vi.fn(async () => {});
    dispatch = vi.fn();
    onDidRestore = new OrderedHookSlot();
    swarmActive = false;
    towerActive = false;
    goalStatus = undefined;
    ix.stub(IAgentPlanService, { exit: planExit } as unknown as IAgentPlanService);
    ix.stub(IAgentSwarmService, {
      exit: swarmExit,
      get isActive() {
        return swarmActive;
      },
    } as unknown as IAgentSwarmService);
    ix.stub(IAgentTowerService, {
      exit: towerExit,
      get isActive() {
        return towerActive;
      },
    } as unknown as IAgentTowerService);
    ix.stub(IAgentGoalService, {
      pauseGoal: goalPause,
      getGoal: () => ({ goal: goalStatus === undefined ? null : { status: goalStatus } }),
    } as unknown as IAgentGoalService);
    ix.stub(IEventDispatcher, {
      dispatch,
      hooks: { onDidRestore },
    } as unknown as IEventDispatcher);
    ix.get(IAgentStateService).contributeState(planKey);
    ix.set(IAgentModeMutexService, new SyncDescriptor(AgentModeMutexService));
    ix.get(IAgentModeMutexService);
  });
  afterEach(() => disposables.dispose());

  function publishGoal(snapshot: GoalSnapshot): void {
    const agentContext = ix.get(IAgentScopeContext).agentContext;
    ix.get(IEventBus).publish(
      new GoalUpdated({ agentId: 'test-agent', snapshot }),
      agentContext,
    );
  }

  it('plan entry exits an active tower mode', async () => {
    towerActive = true;
    await ix.get(IAgentModeMutexService).beforePlanEnter();
    expect(towerExit).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledWith('mode-mutex');
  });

  it('plan entry leaves an inactive tower mode alone', async () => {
    await ix.get(IAgentModeMutexService).beforePlanEnter();
    expect(towerExit).not.toHaveBeenCalled();
  });

  it('swarm entry exits an active tower mode', () => {
    towerActive = true;
    ix.get(IAgentModeMutexService).beforeSwarmEnter();
    expect(towerExit).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledWith('mode-mutex');
  });

  it('swarm entry leaves an inactive tower mode alone', () => {
    ix.get(IAgentModeMutexService).beforeSwarmEnter();
    expect(towerExit).not.toHaveBeenCalled();
  });

  it('tower entry exits an active plan mode and an active swarm mode', async () => {
    ix.get(IAgentStateService).set(planKey, { active: true, id: 'plan_1' });
    swarmActive = true;
    await ix.get(IAgentModeMutexService).beforeTowerEnter();
    expect(planExit).toHaveBeenCalledTimes(1);
    expect(swarmExit).toHaveBeenCalledTimes(1);
  });

  it('tower entry leaves inactive plan and swarm modes alone', async () => {
    await ix.get(IAgentModeMutexService).beforeTowerEnter();
    expect(planExit).not.toHaveBeenCalled();
    expect(swarmExit).not.toHaveBeenCalled();
  });

  it('tower entry pauses an active goal', async () => {
    goalStatus = 'active';
    await ix.get(IAgentModeMutexService).beforeTowerEnter();
    expect(goalPause).toHaveBeenCalledTimes(1);
    expect(goalPause).toHaveBeenCalledWith(
      { reason: 'Paused after tower mode entered' },
      'system',
    );
  });

  it('tower entry leaves a non-active goal alone', async () => {
    goalStatus = 'paused';
    await ix.get(IAgentModeMutexService).beforeTowerEnter();
    expect(goalPause).not.toHaveBeenCalled();
  });

  it('goal activation exits an active tower mode with the mode-mutex reason', () => {
    towerActive = true;
    publishGoal({ status: 'active' } as GoalSnapshot);
    expect(towerExit).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledWith('mode-mutex');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const status = dispatch.mock.calls[0]![0] as AgentStatusUpdated;
    expect(status).toBeInstanceOf(AgentStatusUpdated);
    expect(status).toMatchObject({
      agentId: 'test-agent',
      towerMode: false,
      towerExitReason: 'mode-mutex',
    });
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      towerExit.mock.invocationCallOrder[0]!,
    );
  });

  it('goal activation leaves an inactive tower mode alone', () => {
    publishGoal({ status: 'active' } as GoalSnapshot);
    expect(towerExit).not.toHaveBeenCalled();
  });

  it('a non-active goal update does not exit tower mode', () => {
    towerActive = true;
    publishGoal({ status: 'paused' } as GoalSnapshot);
    expect(towerExit).not.toHaveBeenCalled();
  });

  it('restore reconciles conflicting modes when tower is active', async () => {
    towerActive = true;
    swarmActive = true;
    goalStatus = 'active';
    ix.get(IAgentStateService).set(planKey, { active: true, id: 'plan_1' });

    await onDidRestore.run({});

    expect(planExit).toHaveBeenCalledTimes(1);
    expect(swarmExit).toHaveBeenCalledTimes(1);
    expect(goalPause).toHaveBeenCalledTimes(1);
    expect(towerExit).not.toHaveBeenCalled();
  });

  it('restore leaves non-tower modes alone when tower is inactive', async () => {
    swarmActive = true;
    goalStatus = 'active';
    ix.get(IAgentStateService).set(planKey, { active: true, id: 'plan_1' });

    await onDidRestore.run({});

    expect(planExit).not.toHaveBeenCalled();
    expect(swarmExit).not.toHaveBeenCalled();
    expect(goalPause).not.toHaveBeenCalled();
    expect(towerExit).not.toHaveBeenCalled();
  });
});
