import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLoopService, type PromptSubmitContext } from '#/agent/loop/loop';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentPromptLaunchService } from '#/agent/promptLaunch/promptLaunch';
import { AgentPromptLaunchService } from '#/agent/promptLaunch/promptLaunchService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentGoalService } from '#/features/goal/goalService';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentTowerService } from '#/features/tower/tower';
import { OrderedHookSlot } from '#/hooks';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { PromptLaunch } from '#human/agent/turn';

import { stubAgentScopeContext } from '../../wire/stubs';

describe('AgentPromptLaunchService', () => {
  let disposables: DisposableStore;
  let gate: OrderedHookSlot<PromptSubmitContext>;
  let planActive: boolean;
  let towerActive: boolean;
  let planEnter: ReturnType<typeof vi.fn>;
  let planExit: ReturnType<typeof vi.fn>;
  let towerExit: ReturnType<typeof vi.fn>;
  let createGoal: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    gate = new OrderedHookSlot<PromptSubmitContext>();
    planActive = false;
    towerActive = false;
    planEnter = vi.fn(async () => {
      planActive = true;
    });
    planExit = vi.fn(() => {
      planActive = false;
    });
    towerExit = vi.fn(async () => {
      towerActive = false;
    });
    createGoal = vi.fn(async () => ({}));
    dispatch = vi.fn(async () => undefined);
  });
  afterEach(() => disposables.dispose());

  function setup(agentId = MAIN_AGENT_ID): void {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentLoopService, { hooks: { onBeforeSubmitPrompt: gate } } as unknown as IAgentLoopService);
    ix.stub(IAgentScopeContext, stubAgentScopeContext('prompt-launch-test', agentId));
    ix.stub(IAgentPlanService, {
      status: async () => (planActive ? { id: 'plan_1' } : null),
      enter: planEnter,
      exit: planExit,
    } as unknown as IAgentPlanService);
    ix.stub(IAgentTowerService, {
      get isActive() {
        return towerActive;
      },
      exit: towerExit,
    } as unknown as IAgentTowerService);
    ix.stub(IAgentGoalService, { createGoal } as unknown as IAgentGoalService);
    ix.stub(IEventDispatcher, { dispatch } as unknown as IEventDispatcher);
    ix.set(IAgentPromptLaunchService, new SyncDescriptor(AgentPromptLaunchService));
    ix.get(IAgentPromptLaunchService);
  }

  async function start(launch: PromptLaunch | undefined, block = false): Promise<PromptSubmitContext> {
    const ctx: PromptSubmitContext = {
      promptMessage: { role: 'user', content: [{ type: 'text', text: 'go' }] },
      launch,
      isSteer: false,
      hookParts: [],
      block,
    };
    await gate.run(ctx);
    return ctx;
  }

  it('enters plan mode and leaves Tower when a plan-mode prompt starts', async () => {
    setup();
    towerActive = true;
    await start({ planMode: true });
    expect(planEnter).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledTimes(1);

    await start({ planMode: true });
    expect(planEnter).toHaveBeenCalledTimes(1);
  });

  it('creates the goal and leaves plan mode when a goal prompt starts', async () => {
    setup();
    planActive = true;
    await start({ planMode: true, goalObjective: 'Ship it' });
    expect(createGoal).toHaveBeenCalledWith({ objective: 'Ship it' });
    expect(planExit).toHaveBeenCalledTimes(1);
    expect(planEnter).not.toHaveBeenCalled();
  });

  it('ignores blocked prompts and prompts without a launch', async () => {
    setup();
    await start({ planMode: true }, true);
    await start(undefined);
    expect(planEnter).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('ignores launches on agents other than the main agent', async () => {
    setup('subagent-1');
    await start({ planMode: true, goalObjective: 'Ship it' });
    expect(planEnter).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('warns and still starts the prompt when the requested mode cannot be applied', async () => {
    setup();
    createGoal.mockRejectedValueOnce(new Error('A goal already exists'));
    const ctx = await start({ goalObjective: 'Ship it' });
    expect(ctx.block).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const warning = dispatch.mock.calls[0]![0] as WarningIssued;
    expect(warning).toBeInstanceOf(WarningIssued);
    expect(warning).toMatchObject({
      code: 'prompt-launch-failed',
      message: expect.stringContaining('A goal already exists'),
    });
  });
});
