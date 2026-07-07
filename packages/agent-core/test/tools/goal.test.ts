import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { GoalMode } from '../../src/agent/goal';
import { ErrorCodes } from '../../src/errors';
import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';
import {
  CreateGoalTool,
  CreateGoalToolInputSchema,
  GetGoalTool,
  SetGoalBudgetTool,
  SetGoalBudgetToolInputSchema,
  UpdateGoalTool,
  UpdateGoalToolInputSchema,
} from '../../src/tools/builtin';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeStore() {
  return fakeAgent().goal;
}

function fakeAgent(opts: { type?: 'main' | 'sub'; goal?: GoalMode } = {}): Agent {
  const agent = {
    type: opts.type ?? 'main',
    records: { logRecord: () => {} },
    emitEvent: () => {},
    telemetry: { track: () => {} },
    context: { appendSystemReminder: () => {} },
    permission: { mode: 'manual' },
  } as unknown as Agent;
  (agent as { goal: GoalMode }).goal = opts.goal ?? new GoalMode(agent);
  return agent;
}

function ctx<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_1', args, signal };
}

describe('CreateGoalTool', () => {
  it('creates a goal through the goal store', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({ objective: 'Ship feature X' }));
    expect(result.isError).toBeFalsy();
    expect(store.getGoal().goal?.objective).toBe('Ship feature X');
  });

  it('omits the internal goalId from the model-facing output', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({ objective: 'Ship feature X' }));
    expect(store.getGoal().goal?.goalId).toBeTruthy();
    expect(result.output).not.toContain('goalId');
    expect(result.output).not.toContain(store.getGoal().goal?.goalId ?? 'no-id');
  });

  it('passes completionCriterion and replace', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    await executeTool(tool, ctx({ objective: 'first' }));
    await executeTool(
      tool,
      ctx({
        objective: 'second',
        completionCriterion: 'tests pass',
        replace: true,
      }),
    );
    const goal = store.getGoal().goal!;
    expect(goal.objective).toBe('second');
    expect(goal.completionCriterion).toBe('tests pass');
    expect(goal.budget.tokenBudget).toBeNull();
  });

  it('rejects empty and too-long objectives via the store', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goal: store }));
    await expect(executeTool(tool, ctx({ objective: '   ' }))).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
    await expect(executeTool(tool, ctx({ objective: 'x'.repeat(4001) }))).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('uses the imported markdown description', () => {
    const tool = new CreateGoalTool(fakeAgent());
    expect(tool.description).toContain('Create a durable, structured goal');
    expect(tool.description).not.toContain('SetGoalBudget');
  });

  it('warns that creating fails when a goal already exists', () => {
    const description = new CreateGoalTool(fakeAgent()).description.toLowerCase();
    // agent/goal/index.ts throws "A goal already exists; use replace..." without replace:true.
    expect(description).toContain('already exists');
    expect(description).toContain('replace');
    // The replace param blocks on any persisted goal, including `blocked` (index.ts).
    const replaceDesc =
      ((new CreateGoalTool(fakeAgent()).parameters as {
        properties: Record<string, { description?: string }>;
      }).properties['replace']?.description) ?? '';
    expect(replaceDesc).toContain('blocked');
  });
});

describe('GetGoalTool', () => {
  it('returns { goal: null } when no goal exists', async () => {
    const store = makeStore();
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({}));
    expect(JSON.parse(result.output as string)).toEqual({ goal: null });
  });

  it('returns active goal state with budgets', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.setBudgetLimits({ budgetLimits: { tokenBudget: 100 } }, 'model');
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    const result = await executeTool(tool, ctx({}));
    const parsed = JSON.parse(result.output as string);
    expect(parsed.goal.status).toBe('active');
    expect(parsed.goal.budget.tokenBudget).toBe(100);
    expect(parsed.goal.budget.remainingTokens).toBe(100);
  });

  it('returns paused and blocked snapshots', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    const tool = new GetGoalTool(fakeAgent({ goal: store }));
    let parsed = JSON.parse((await executeTool(tool, ctx({}))).output as string);
    expect(parsed.goal.status).toBe('paused');
    await store.resumeGoal();
    await store.markBlocked({ reason: 'stuck' });
    parsed = JSON.parse((await executeTool(tool, ctx({}))).output as string);
    expect(parsed.goal.status).toBe('blocked');
  });

  it('describes only the fields GetGoal actually returns', () => {
    const description = new GetGoalTool(fakeAgent()).description.toLowerCase();
    expect(description).toContain('objective');
    expect(description).toContain('budget');
    // GoalSnapshot has no self-report / evaluator-verdict fields, so the
    // description must not promise them (serialize.ts strips only goalId).
    expect(description).not.toContain('self-report');
    expect(description).not.toContain('evaluator');
  });
});

describe('SetGoalBudgetTool', () => {
  it('states the 1-second to 24-hour time-budget band', () => {
    const description = new SetGoalBudgetTool(fakeAgent()).description;
    // set-goal-budget.ts rejects time budgets < 1s or > 24h (MIN/MAX_REASONABLE_TIME_BUDGET_MS).
    expect(description).toContain('1 second');
    expect(description).toContain('24 hours');
    // turn/token budgets are floored at 1 and rounded to the nearest whole number
    // (Math.max(1, Math.round(value))) — the description must not claim "rounded up".
    expect(description).toContain('rounded to the nearest whole number');
    expect(description).not.toContain('rounded up');
  });

  it('advertises an object parameter schema for OpenAI-compatible providers', () => {
    const parameters = new SetGoalBudgetTool(fakeAgent()).parameters;

    expect(parameters).toMatchObject({
      type: 'object',
      required: ['value', 'unit'],
      additionalProperties: false,
      properties: {
        value: expect.objectContaining({ type: 'number', exclusiveMinimum: 0 }),
        unit: expect.objectContaining({
          type: 'string',
          enum: ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'],
        }),
      },
    });
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters).not.toHaveProperty('anyOf');

    const validator = compileToolArgsValidator(parameters);
    expect(validateToolArgs(validator, { value: 1.5, unit: 'turns' })).toBeNull();
    expect(validateToolArgs(validator, { value: 1.5, unit: 'hours' })).toBeNull();
  });

  it('accepts a value with a supported budget unit', () => {
    for (const unit of ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours']) {
      expect(SetGoalBudgetToolInputSchema.safeParse({ value: 20, unit }).success).toBe(true);
    }
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 0, unit: 'turns' }).success).toBe(false);
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 1, unit: 'years' }).success).toBe(false);
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 1.5, unit: 'turns' }).success).toBe(true);
    expect(SetGoalBudgetToolInputSchema.safeParse({ value: 1.5, unit: 'hours' }).success).toBe(true);
  });

  it('sets turn, token, and time budgets on the current goal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    expect((await executeTool(tool, ctx({ value: 20, unit: 'turns' }))).output).toBe(
      'Goal budget set: 20 turns.',
    );
    expect(store.getGoal().goal?.budget.turnBudget).toBe(20);

    expect((await executeTool(tool, ctx({ value: 500_000, unit: 'tokens' }))).output).toBe(
      'Goal budget set: 500000 tokens.',
    );
    expect(store.getGoal().goal?.budget.tokenBudget).toBe(500_000);

    expect((await executeTool(tool, ctx({ value: 30, unit: 'minutes' }))).output).toBe(
      'Goal budget set: 30 minutes.',
    );
    expect(store.getGoal().goal?.budget.wallClockBudgetMs).toBe(30 * 60 * 1000);
  });

  it('reports no current goal instead of throwing when no goal exists', async () => {
    const tool = new SetGoalBudgetTool(fakeAgent());

    const result = await executeTool(tool, ctx({ value: 20, unit: 'turns' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Goal budget not set: no current goal.');
  });

  it('rounds fractional turn and token budgets before setting them', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    expect((await executeTool(tool, ctx({ value: 1.5, unit: 'turns' }))).output).toBe(
      'Goal budget set: 2 turns.',
    );
    expect(store.getGoal().goal?.budget.turnBudget).toBe(2);

    expect((await executeTool(tool, ctx({ value: 0.4, unit: 'tokens' }))).output).toBe(
      'Goal budget set: 1 token.',
    );
    expect(store.getGoal().goal?.budget.tokenBudget).toBe(1);
  });

  it('ignores unreasonable time budgets and tells the model why', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    const tiny = await executeTool(tool, ctx({ value: 1, unit: 'milliseconds' }));
    expect(tiny.isError).toBeFalsy();
    expect(tiny.output).toContain('not a reasonable goal budget');
    expect(store.getGoal().goal?.budget.wallClockBudgetMs).toBeNull();

    const huge = await executeTool(tool, ctx({ value: 8760, unit: 'hours' }));
    expect(huge.isError).toBeFalsy();
    expect(huge.output).toContain('not a reasonable goal budget');
    expect(store.getGoal().goal?.budget.wallClockBudgetMs).toBeNull();
  });

  it('stops the batch and turn when the new budget is already exhausted', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn(); // turnsUsed = 1
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    const execution = tool.resolveExecution({ value: 1, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    expect(execution.stopBatchAfterThis).toBe(true);

    const result = await execution.execute({ turnId: '0', toolCallId: 'call_1', signal });
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('will stop now');
    expect(store.getGoal().goal?.budget.overBudget).toBe(true);
  });

  it('does not stop when the new budget leaves room', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.incrementTurn(); // turnsUsed = 1
    const tool = new SetGoalBudgetTool(fakeAgent({ goal: store }));

    const execution = tool.resolveExecution({ value: 5, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');
    expect(execution.stopBatchAfterThis).toBeFalsy();

    const result = await execution.execute({ turnId: '0', toolCallId: 'call_1', signal });
    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe('Goal budget set: 5 turns.');
  });
});

describe('UpdateGoalTool', () => {
  it('guards against premature blocked status', () => {
    const description = new UpdateGoalTool(fakeAgent()).description.toLowerCase();
    // Reserve blocked for genuine impasses, not ordinary unfinished work.
    expect(description).toContain('genuine impasse');
    expect(description).toContain('hard, slow');
    expect(description).toContain('needs more goal turns');
    // UpdateGoal also injects the completion/blocked outcome prompt, so it does
    // more than "only record the status".
    expect(description).not.toContain('only records the status');
  });

  it('discourages calling UpdateGoal after a non-terminal work slice', () => {
    const description = new UpdateGoalTool(fakeAgent()).description;
    expect(description).toContain('Most active goal turns should not call this tool');
    expect(description).toContain('end the turn normally without calling UpdateGoal');
    expect(description).toContain('every required part of the objective is done');
  });

  // Keep a capturing context here to prove terminal paths no longer append a
  // separate reminder; the outcome prompt is returned as the tool result.
  function agentWithContext(
    store: GoalMode,
    reminders: Array<{ readonly content: string; readonly origin: unknown }> = [],
  ): Agent {
    return {
      type: 'main',
      goal: store,
      context: {
        appendSystemReminder: (content: string, origin: unknown) => {
          reminders.push({ content, origin });
        },
      },
    } as unknown as Agent;
  }

  it('accepts only active / complete / blocked', () => {
    for (const status of ['active', 'complete', 'blocked']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(true);
    }
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'blocked', reason: 'x' }).success).toBe(false);
    for (const status of ['paused', 'impossible', 'cancelled', '']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(false);
    }
  });

  it('forbids model-driven goal pauses', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new UpdateGoalTool(agentWithContext(store));
    const validator = compileToolArgsValidator(tool.parameters);

    expect(validateToolArgs(validator, { status: 'paused' })).not.toBeNull();

    const execution = tool.resolveExecution({ status: 'paused' } as never);
    expect(execution).toMatchObject({
      isError: true,
      output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
    });
    expect(store.getGoal().goal?.status).toBe('active');
  });

  it('`complete` marks the goal complete and clears it (transient)', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work' });
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store, reminders)),
      ctx({ status: 'complete' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal completed successfully.');
    expect(result.output).toContain('Write a concise final message for the user');
    expect(store.getGoal().goal).toBeNull();
    expect(reminders).toHaveLength(0);
  });

  it('`blocked` marks the goal blocked (resumable) and asks for a blocker reason', async () => {
    const store = makeStore();
    const reminders: Array<{ readonly content: string; readonly origin: unknown }> = [];
    await store.createGoal({ objective: 'work' });
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store, reminders)),
      ctx({ status: 'blocked' }),
    );
    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('Goal blocked.');
    expect(result.output).toContain('concrete blocker');
    expect(store.getGoal().goal?.status).toBe('blocked');
    expect(store.getGoal().goal?.terminalReason).toBeUndefined();
    expect(reminders).toHaveLength(0);
  });

  it('`active` resumes a paused goal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    const result = await executeTool(new UpdateGoalTool(agentWithContext(store)), ctx({ status: 'active' }));
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Goal resumed.');
    expect(store.getGoal().goal?.status).toBe('active');
  });

  it.each([
    ['active', 'Goal not resumed: no current goal.'],
    ['complete', 'Goal not completed: no active goal.'],
    ['blocked', 'Goal not blocked: no active goal.'],
  ] as const)('reports a no-goal result for `%s` without stopping the turn', async (status, output) => {
    const tool = new UpdateGoalTool(agentWithContext(makeStore()));
    const execution = tool.resolveExecution({ status });
    if (execution.isError === true) throw new Error('execution should not be an error');

    expect(execution.stopBatchAfterThis).toBeFalsy();
    const result = await execution.execute({ turnId: '0', toolCallId: 'call_1', signal });

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe(output);
  });
});

describe('ToolManager goal tool registration', () => {
  function loopToolNames(type: 'main' | 'sub'): readonly string[] {
    const ctxAgent = testAgent({
      type,
    });
    // configure() gives the agent a provider so builtin tools can initialize.
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] });
    // Re-run registration so the gate reads the scoped flag resolver state.
    ctxAgent.agent.tools.initializeBuiltinTools();
    return ctxAgent.agent.tools.loopTools.map((tool) => tool.name);
  }

  it('exposes goal tools to the main agent', () => {
    const names = loopToolNames('main');
    expect(names).toEqual(
      expect.arrayContaining(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']),
    );
  });

  it('does not expose goal tools to subagents even when enabled', () => {
    const names = loopToolNames('sub');
    expect(names).not.toContain('CreateGoal');
    expect(names).not.toContain('GetGoal');
    expect(names).not.toContain('SetGoalBudget');
    expect(names).not.toContain('UpdateGoal');
  });

  it('keeps goal mutation tools visible across goal lifecycle states', async () => {
    const store = makeStore();
    const ctxAgent = testAgent({
      type: 'main',
      goal: store,
    });
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] });
    ctxAgent.agent.tools.initializeBuiltinTools();
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');

    await store.createGoal({ objective: 'work' });
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');

    await store.markComplete({}, 'model');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');
  });
});

describe('CreateGoalToolInputSchema', () => {
  it('accepts a minimal objective and a full payload', () => {
    expect(CreateGoalToolInputSchema.safeParse({ objective: 'x' }).success).toBe(true);
    expect(
      CreateGoalToolInputSchema.safeParse({
        objective: 'x',
        completionCriterion: 'done',
        replace: true,
      }).success,
    ).toBe(true);
    expect(
      CreateGoalToolInputSchema.safeParse({
        objective: 'x',
        budgetLimits: { tokenBudget: 1 },
      }).success,
    ).toBe(false);
  });
});
