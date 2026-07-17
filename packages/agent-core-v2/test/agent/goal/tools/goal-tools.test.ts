/**
 * Scenario: model-facing goal tool validation and delayed execution.
 * Responsibilities: verify goal commands target the goal selected when execution is resolved.
 * Wiring: real goal service; loop is stubbed at the agent boundary.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/goal/tools/goal-tools.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { ToolCall } from '#/app/llmProtocol/message';
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
import {
  IAgentToolExecutorService,
  type ToolExecutionResult,
} from '#/agent/toolExecutor/toolExecutor';
import { getToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';

import {
  agentService,
  createTestAgent,
  permissionModeServices,
  type TestAgentContext,
} from '../../../harness';
import { stubLoopWithHooks } from '../../loop/stubs';

const signal = new AbortController().signal;

describe('goal tools', () => {
  let ctx: TestAgentContext;
  let goals: IAgentGoalService;
  let loopService: IAgentLoopService;
  let eventBus: IEventBus;
  let toolExecutor: IAgentToolExecutorService;
  let setGoalBudgetTool: SetGoalBudgetTool;
  let updateGoalTool: UpdateGoalTool;

  beforeEach(() => {
    loopService = stubLoopWithHooks({ hasActiveTurn: true });
    ctx = createTestAgent(
      agentService(IAgentLoopService, loopService),
      permissionModeServices('auto'),
    );
    goals = ctx.get(IAgentGoalService);
    eventBus = ctx.get(IEventBus);
    toolExecutor = ctx.get(IAgentToolExecutorService);
    setGoalBudgetTool = new SetGoalBudgetTool(goals);
    updateGoalTool = new UpdateGoalTool(goals, { evaluate: async () => ({ ok: true, reason: '' }) } as any);
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('CreateGoal does not apply a delayed execution to a replacement goal', async () => {
    await goals.createGoal({ objective: 'old task' });
    eventBus.publish({ type: 'turn.started', turnId: 6, origin: USER_PROMPT_ORIGIN });
    const tool = ctx.get(IAgentToolRegistryService).resolve('CreateGoal');
    if (tool === undefined) throw new Error('CreateGoal should be registered');
    const execution = await tool.resolveExecution({ objective: 'stale task', replace: true });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    const result = await execution.execute({
      turnId: 6,
      toolCallId: 'call_old_create',
      signal,
    });

    expect(result.output).toBe('Goal not created: the current goal changed.');
    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      objective: 'new task',
    });
  });

  it('CreateGoal does not apply a no-goal execution to an externally created goal', async () => {
    eventBus.publish({ type: 'turn.started', turnId: 7, origin: USER_PROMPT_ORIGIN });
    const tool = ctx.get(IAgentToolRegistryService).resolve('CreateGoal');
    if (tool === undefined) throw new Error('CreateGoal should be registered');
    const execution = await tool.resolveExecution({ objective: 'stale task', replace: true });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const created = await goals.createGoal({ objective: 'external task' });

    const result = await execution.execute({
      turnId: 7,
      toolCallId: 'call_old_create',
      signal,
    });

    expect(result.output).toBe('Goal not created: the current goal changed.');
    expect(goals.getGoal().goal).toMatchObject({
      goalId: created.goalId,
      objective: 'external task',
    });
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
      status: 'budget_limited',
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

  it('SetGoalBudget does not apply a delayed execution to a replacement goal', async () => {
    await goals.createGoal({ objective: 'old task' });
    const execution = setGoalBudgetTool.resolveExecution({ value: 5, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    const result = await execution.execute({ turnId: 0, toolCallId: 'call_old_budget', signal });

    expect(result.output).toBe('Goal budget not set: the current goal changed.');
    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      budget: { turnBudget: null },
    });
  });

  it('SetGoalBudget does not apply a no-goal execution to an externally created goal', async () => {
    const execution = setGoalBudgetTool.resolveExecution({ value: 5, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const created = await goals.createGoal({ objective: 'external task' });

    const result = await execution.execute({ turnId: 0, toolCallId: 'call_old_budget', signal });

    expect(result.output).toBe('Goal budget not set: the current goal changed.');
    expect(goals.getGoal().goal).toMatchObject({
      goalId: created.goalId,
      budget: { turnBudget: null },
    });
  });

  it('SetGoalBudget ignores a stale call from a replaced goal turn', async () => {
    await goals.createGoal({ objective: 'old task' });
    eventBus.publish({ type: 'turn.started', turnId: 1, origin: USER_PROMPT_ORIGIN });
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    const results = await executeGoalCalls(
      [goalToolCall('call_old_budget', 'SetGoalBudget', { value: 5, unit: 'turns' })],
      1,
    );

    expect(results[0]?.result.output).toBe(
      'Goal changed since this turn started; ignored stale goal tool call.',
    );
    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      budget: { turnBudget: null },
    });
  });

  it('SetGoalBudget applies a delayed execution to a goal created earlier in the same batch', async () => {
    eventBus.publish({ type: 'turn.started', turnId: 2, origin: USER_PROMPT_ORIGIN });

    const results = await executeGoalCalls(
      [
        goalToolCall('call_create', 'CreateGoal', { objective: 'new task' }),
        goalToolCall('call_budget', 'SetGoalBudget', { value: 5, unit: 'turns' }),
      ],
      2,
    );

    expect(results.find((result) => result.toolName === 'SetGoalBudget')?.result.output).toBe(
      'Goal budget set: 5 turns.',
    );
    expect(goals.getGoal().goal).toMatchObject({
      objective: 'new task',
      budget: { turnBudget: 5 },
    });
  });

  it('SetGoalBudget applies a same-batch budget to the replacement goal', async () => {
    await goals.createGoal({ objective: 'old task' });
    eventBus.publish({ type: 'turn.started', turnId: 3, origin: USER_PROMPT_ORIGIN });

    const results = await executeGoalCalls(
      [
        goalToolCall('call_replace', 'CreateGoal', { objective: 'new task', replace: true }),
        goalToolCall('call_budget', 'SetGoalBudget', { value: 5, unit: 'turns' }),
      ],
      3,
    );

    expect(results.find((result) => result.toolName === 'SetGoalBudget')?.result.output).toBe(
      'Goal budget set: 5 turns.',
    );
    expect(goals.getGoal().goal).toMatchObject({
      objective: 'new task',
      budget: { turnBudget: 5 },
    });
  });

  it('UpdateGoal accepts only complete / blocked statuses', () => {
    for (const status of ['complete', 'blocked']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(true);
    }
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'blocked', reason: 'x' }).success).toBe(
      false,
    );
    for (const status of ['active', 'paused', 'impossible', 'cancelled', '']) {
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
      output: 'Invalid goal status. Use `complete` or `blocked`.',
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

  it('UpdateGoal blocked requires 3 consecutive blocked calls before stopping the turn', async () => {
    await goals.createGoal({ objective: 'ship it' });

    // Attempt 1/3
    const r1 = await updateGoalTool.resolveExecution({ status: 'blocked' }).execute({ turnId: 0, toolCallId: 'call_b1', signal });
    expect(r1.stopTurn).toBeFalsy();
    expect(r1.output).toContain('attempt 1/3');
    // Manually record blocked attempts for the remaining calls
    await goals.recordBlockedAttempt();
    expect(goals.getGoal().goal?.blockedStreak).toBe(2);

    // Attempt 3/3: now actually blocked
    const result = await updateGoalTool.resolveExecution({ status: 'blocked' }).execute({ turnId: 0, toolCallId: 'call_b3', signal });
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal blocked.');
    expect(result.output).toContain('Worked');
    expect(result.output).toContain('concrete blocker');
  });

  it('UpdateGoal does not apply a delayed outcome to a replacement goal', async () => {
    await goals.createGoal({ objective: 'old task' });
    const execution = updateGoalTool.resolveExecution({ status: 'complete' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const replacement = await goals.createGoal({ objective: 'new task', replace: true });

    const result = await execution.execute({ turnId: 0, toolCallId: 'call_old_outcome', signal });

    expect(result.output).toBe('Goal not completed: the current goal changed.');
    expect(result.stopTurn).toBeFalsy();
    expect(goals.getGoal().goal).toMatchObject({
      goalId: replacement.goalId,
      status: 'active',
    });
  });

  it('UpdateGoal does not apply a no-goal outcome to an externally created goal', async () => {
    const execution = updateGoalTool.resolveExecution({ status: 'complete' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    const created = await goals.createGoal({ objective: 'external task' });

    const result = await execution.execute({
      turnId: 0,
      toolCallId: 'call_old_outcome',
      signal,
    });

    expect(result.output).toBe('Goal not completed: the current goal changed.');
    expect(result.stopTurn).toBeFalsy();
    expect(goals.getGoal().goal).toMatchObject({
      goalId: created.goalId,
      status: 'active',
    });
  });

  it.each([
    ['complete', null, 'Goal completed successfully'],
    ['blocked', 'active', 'attempt 1/3'],
  ] as const)(
    'UpdateGoal applies %s to a goal replaced earlier in the same batch',
    async (updateStatus, expectedCurrentStatus, expectedOutput) => {
      await goals.createGoal({ objective: 'old task' });
      eventBus.publish({ type: 'turn.started', turnId: 4, origin: USER_PROMPT_ORIGIN });

      const results = await executeGoalCalls(
        [
          goalToolCall('call_replace', 'CreateGoal', { objective: 'new task', replace: true }),
          goalToolCall('call_outcome', 'UpdateGoal', { status: updateStatus }),
        ],
        4,
      );

      const outcome = results.find((result) => result.toolName === 'UpdateGoal')?.result;
      expect(outcome?.output).toContain(expectedOutput);
      if (updateStatus === 'complete') {
        expect(outcome?.stopTurn).toBe(true);
      }
      expect(goals.getGoal().goal?.status ?? null).toBe(expectedCurrentStatus);
    },
  );

  it.each([
    ['complete', null, 'Goal completed successfully'],
    ['blocked', 'active', 'attempt 1/3'],
  ] as const)(
    'UpdateGoal applies %s when the goal was created earlier in the same batch',
    async (updateStatus, expectedCurrentStatus, expectedOutput) => {
      eventBus.publish({ type: 'turn.started', turnId: 5, origin: USER_PROMPT_ORIGIN });

      const results = await executeGoalCalls(
        [
          goalToolCall('call_create', 'CreateGoal', { objective: 'new task', replace: true }),
          goalToolCall('call_outcome', 'UpdateGoal', { status: updateStatus }),
        ],
        5,
      );

      const outcome = results.find((result) => result.toolName === 'UpdateGoal')?.result;
      expect(outcome?.output).toContain(expectedOutput);
      if (updateStatus === 'complete') {
        expect(outcome?.stopTurn).toBe(true);
      }
      expect(goals.getGoal().goal?.status ?? null).toBe(expectedCurrentStatus);
    },
  );

  it('UpdateGoal reports no active goal when completing/blocking without one', async () => {
    const done = updateGoalTool.resolveExecution({ status: 'complete' });
    if (done.isError === true) throw new Error('execution should not be an error');
    const doneResult = await done.execute({ turnId: 0, toolCallId: 'call_n1', signal });
    expect(doneResult.output).toBe('Goal not completed: no active goal.');

    const blocked = updateGoalTool.resolveExecution({ status: 'blocked' });
    if (blocked.isError === true) throw new Error('execution should not be an error');
    const blockedResult = await blocked.execute({ turnId: 0, toolCallId: 'call_n2', signal });
    expect(blockedResult.output).toBe('Goal not blocked: no active goal.');

    const resumed = updateGoalTool.resolveExecution({ status: 'active' } as never);
    expect(resumed.isError).toBe(true);
    expect((resumed as any).output).toBe('Invalid goal status. Use `complete` or `blocked`.');
  });

  it('GetGoal returns the current goal snapshot', async () => {
    await goals.createGoal({ objective: 'test goal for GetGoal' });
    const tool = ctx.get(IAgentToolRegistryService).resolve('GetGoal');
    if (tool === undefined) throw new Error('GetGoal should be registered');
    const execution = await tool.resolveExecution({});
    if (execution.isError === true) throw new Error('execution should not be an error');
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_get', signal });
    expect(result.output).toContain('test goal for GetGoal');
  });

  it('GetGoal returns no-goal message when there is no current goal', async () => {
    const tool = ctx.get(IAgentToolRegistryService).resolve('GetGoal');
    if (tool === undefined) throw new Error('GetGoal should be registered');
    const execution = await tool.resolveExecution({});
    if (execution.isError === true) throw new Error('execution should not be an error');
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_get_none', signal });
    expect(result.output).toContain('null');
    expect(result.output).toContain('goal');
  });

  it('SetGoalBudget clamps negative values to a positive budget', async () => {
    await goals.createGoal({ objective: 'work' });
    const negative = setGoalBudgetTool.resolveExecution({ value: -1, unit: 'turns' });
    if (negative.isError === true) throw new Error('execution should not be an error');
    const negativeResult = await negative.execute({ turnId: 0, toolCallId: 'call_neg', signal });
    expect(negativeResult.output).toContain('Goal budget set');
    expect(negativeResult.isError).toBeFalsy();
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

  async function executeGoalCalls(
    calls: ToolCall[],
    turnId: number,
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for await (const result of toolExecutor.execute(calls, { turnId, signal })) {
      results.push(result);
    }
    return results;
  }

  function goalToolCall(
    id: string,
    name: 'CreateGoal' | 'GetGoal' | 'SetGoalBudget' | 'UpdateGoal',
    args: Record<string, unknown>,
  ): ToolCall {
    return { type: 'function', id, name, arguments: JSON.stringify(args) };
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
