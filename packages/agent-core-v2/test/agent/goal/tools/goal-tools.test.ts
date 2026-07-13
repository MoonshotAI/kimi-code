import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import {
  compileToolArgsValidator,
  validateToolArgs,
} from '#/tool/args-validator';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { CreateGoalTool } from '#/agent/goal/tools/create-goal';
import { GetGoalTool } from '#/agent/goal/tools/get-goal';
import { SetGoalBudgetTool } from '#/agent/goal/tools/set-goal-budget';
import {
  UpdateGoalTool,
  UpdateGoalToolInputSchema,
} from '#/agent/goal/tools/update-goal';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { getToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IEventBus } from '#/app/event/eventBus';

import { agentService, createTestAgent, type TestAgentContext } from '../../../harness';
import { stubLoopWithHooks } from '../../loop/stubs';

const signal = new AbortController().signal;

describe('goal tools', () => {
  let ctx: TestAgentContext;
  let goals: IAgentGoalService;
  let loopService: IAgentLoopService;
  let eventBus: IEventBus;
  let setGoalBudgetTool: SetGoalBudgetTool;
  let updateGoalTool: UpdateGoalTool;

  beforeEach(() => {
    loopService = stubLoopWithHooks({ hasActiveTurn: true });
    ctx = createTestAgent(agentService(IAgentLoopService, loopService));
    goals = ctx.get(IAgentGoalService);
    eventBus = ctx.get(IEventBus);
    setGoalBudgetTool = new SetGoalBudgetTool(goals);
    updateGoalTool = new UpdateGoalTool(goals);
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('SetGoalBudget reports no current goal without failing', async () => {
    const execution = setGoalBudgetTool.resolveExecution({ value: 20, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');

    const result = await execution.execute({ turnId: 0, toolCallId: 'call_1', signal });

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe('Goal budget not set: no current goal.');
  });

  it('SetGoalBudget returns stop signals when the requested limit is already exhausted', async () => {
    await goals.createGoal({ objective: 'work' });
    await countGoalTurn(1);

    const execution = setGoalBudgetTool.resolveExecution({ value: 1, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');

    expect(execution.stopBatchAfterThis).toBe(true);
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_1', signal });

    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('will stop now');
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      budget: { overBudget: true },
    });
  });

  it('SetGoalBudget leaves the turn running when the requested limit has room', async () => {
    await goals.createGoal({ objective: 'work' });
    await countGoalTurn(2);

    const execution = setGoalBudgetTool.resolveExecution({ value: 5, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');

    expect(execution.stopBatchAfterThis).toBeFalsy();
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_1', signal });

    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe('Goal budget set: 5 turns.');
    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      budget: { turnBudget: 5, overBudget: false },
    });
  });

  it('UpdateGoal accepts only active / complete / blocked statuses', () => {
    for (const status of ['active', 'complete', 'blocked']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(true);
    }
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'blocked', reason: 'x' }).success).toBe(
      false,
    );
    for (const status of ['paused', 'impossible', 'cancelled', '']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(false);
    }
  });

  it('UpdateGoal forbids model-driven goal pauses', async () => {
    await goals.createGoal({ objective: 'work' });
    const validator = compileToolArgsValidator(updateGoalTool.parameters);

    expect(validateToolArgs(validator, { status: 'paused' })).not.toBeNull();

    const execution = updateGoalTool.resolveExecution({ status: 'paused' } as never);
    expect(execution).toMatchObject({
      isError: true,
      output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
    });
    expect(goals.getGoal().goal?.status).toBe('active');
  });

  it('UpdateGoal complete returns the completion summary prompt and stops the turn', async () => {
    await goals.createGoal({ objective: 'ship it' });
    const execution = updateGoalTool.resolveExecution({ status: 'complete' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_c', signal });

    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal completed successfully');
    expect(result.output).toContain('Worked');
    expect(result.output).toContain('Write a concise final message for the user');
  });

  it('UpdateGoal blocked returns the blocked-reason prompt and stops the turn', async () => {
    await goals.createGoal({ objective: 'ship it' });
    const execution = updateGoalTool.resolveExecution({ status: 'blocked' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_b', signal });

    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal blocked.');
    expect(result.output).toContain('Worked');
    expect(result.output).toContain('concrete blocker');
  });

  it('UpdateGoal reports no active goal when completing/blocking/resuming without one', async () => {
    const done = updateGoalTool.resolveExecution({ status: 'complete' });
    if (done.isError === true) throw new Error('execution should not be an error');
    const doneResult = await done.execute({ turnId: 0, toolCallId: 'call_n1', signal });
    expect(doneResult.output).toBe('Goal not completed: no active goal.');

    const blocked = updateGoalTool.resolveExecution({ status: 'blocked' });
    if (blocked.isError === true) throw new Error('execution should not be an error');
    const blockedResult = await blocked.execute({ turnId: 0, toolCallId: 'call_n2', signal });
    expect(blockedResult.output).toBe('Goal not blocked: no active goal.');

    const resumed = updateGoalTool.resolveExecution({ status: 'active' });
    if (resumed.isError === true) throw new Error('execution should not be an error');
    const resumedResult = await resumed.execute({ turnId: 0, toolCallId: 'call_n3', signal });
    expect(resumedResult.output).toBe('Goal not resumed: no current goal.');
  });

  async function countGoalTurn(turnId: number): Promise<void> {
    const abortController = new AbortController();
    eventBus.publish({ type: 'turn.started', turnId, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.onWillBeginStep.run({
      turnId,
      step: 1,
      signal: abortController.signal,
    });
  }
});

describe('goal tool main-agent gating', () => {
  const gatedTools = [
    ['CreateGoalTool', CreateGoalTool],
    ['GetGoalTool', GetGoalTool],
    ['SetGoalBudgetTool', SetGoalBudgetTool],
    ['UpdateGoalTool', UpdateGoalTool],
  ] as const;

  function accessorFor(agentId: string): ServicesAccessor {
    const scopeContext: IAgentScopeContext = {
      _serviceBrand: undefined,
      agentId,
      scope: () => '',
    };
    return { get: () => scopeContext } as unknown as ServicesAccessor;
  }

  it.each(gatedTools)('%s is contributed with a main-agent-only guard', (name, ctor) => {
    const contribution = getToolContributions().find((c) => c.ctor === ctor);
    expect(contribution, `${name} contribution`).toBeDefined();
    const when = contribution?.options.when;
    expect(when, `${name} must gate on agent identity`).toBeDefined();
    expect(when?.(accessorFor('main'))).toBe(true);
    expect(when?.(accessorFor('sub-1'))).toBe(false);
  });
});
