import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { GoalMode } from '../../src/agent/goal';
import { ErrorCodes } from '../../src/errors';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
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
});

describe('SetGoalBudgetTool', () => {
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
});

describe('UpdateGoalTool', () => {
  // The complete path appends a context reminder, so the agent needs a context
  // exposing appendSystemReminder.
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

  it('accepts only active / complete / paused / blocked', () => {
    for (const status of ['active', 'complete', 'paused', 'blocked']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(true);
    }
    for (const status of ['impossible', 'cancelled', '']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status }).success).toBe(false);
    }
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
    expect(store.getGoal().goal).toBeNull();
    expect(reminders).toEqual([
      {
        content:
          'The current goal was marked complete and cleared. ' +
          'Handle the next user request normally unless the user starts or resumes a goal.',
        origin: { kind: 'system_trigger', name: 'goal_completion' },
      },
    ]);
  });

  it('`blocked` marks the goal blocked (resumable)', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store)),
      ctx({ status: 'blocked' }),
    );
    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal?.status).toBe('blocked');
  });

  it('`paused` marks the goal paused', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const result = await executeTool(
      new UpdateGoalTool(agentWithContext(store)),
      ctx({ status: 'paused' }),
    );
    expect(result.stopTurn).toBe(true);
    expect(store.getGoal().goal?.status).toBe('paused');
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
});

describe('ToolManager goal tool registration', () => {
  function loopToolNames(type: 'main' | 'sub', goalEnabled: boolean): readonly string[] {
    const ctxAgent = testAgent({
      type,
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, {
        goal_command: goalEnabled,
      }),
    });
    // configure() gives the agent a provider so builtin tools can initialize.
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'SetGoalBudget'] });
    // Re-run registration so the gate reads the scoped flag resolver state.
    ctxAgent.agent.tools.initializeBuiltinTools();
    return ctxAgent.agent.tools.loopTools.map((tool) => tool.name);
  }

  it('omits goal tools when the flag is disabled', () => {
    const names = loopToolNames('main', false);
    expect(names).not.toContain('CreateGoal');
    expect(names).not.toContain('GetGoal');
    expect(names).not.toContain('SetGoalBudget');
  });

  it('exposes goal tools to the main agent when the flag is enabled', () => {
    const names = loopToolNames('main', true);
    expect(names).toEqual(expect.arrayContaining(['CreateGoal', 'GetGoal']));
    expect(names).not.toContain('SetGoalBudget');
  });

  it('does not expose goal tools to subagents even when enabled', () => {
    const names = loopToolNames('sub', true);
    expect(names).not.toContain('CreateGoal');
    expect(names).not.toContain('GetGoal');
    expect(names).not.toContain('SetGoalBudget');
  });

  it('hides goal mutation tools until a goal exists, then exposes them', async () => {
    const store = makeStore();
    const ctxAgent = testAgent({
      type: 'main',
      goal: store,
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, {
        goal_command: true,
      }),
    });
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] });
    ctxAgent.agent.tools.initializeBuiltinTools();
    // No goal yet -> mutation tools are filtered out of the model's tool list.
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).not.toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).not.toContain('SetGoalBudget');
    // Once a goal exists, it appears.
    await store.createGoal({ objective: 'work' });
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');

    await store.markComplete({}, 'model');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).not.toContain('UpdateGoal');
    expect(ctxAgent.agent.tools.loopTools.map((t) => t.name)).not.toContain('SetGoalBudget');
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
