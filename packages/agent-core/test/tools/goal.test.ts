import { afterEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { ErrorCodes } from '../../src/errors';
import {
  CreateGoalTool,
  CreateGoalToolInputSchema,
  GetGoalTool,
  UpdateGoalTool,
  UpdateGoalToolInputSchema,
} from '../../src/tools/builtin';
import { SessionGoalStore, type SessionGoalState } from '../../src/session/goal';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeStore() {
  let state: SessionGoalState | undefined;
  return new SessionGoalStore({
    sessionId: 'test',
    readState: () => state,
    writeState: async (next) => {
      state = next;
    },
  });
}

function fakeAgent(opts: { type?: 'main' | 'sub'; goals?: SessionGoalStore } = {}): Agent {
  return { type: opts.type ?? 'main', goals: opts.goals } as unknown as Agent;
}

function ctx<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_1', args, signal };
}

const GOAL_FLAG = 'KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND';

describe('CreateGoalTool', () => {
  it('creates a goal through the goal store', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goals: store }));
    const result = await executeTool(tool, ctx({ objective: 'Ship feature X' }));
    expect(result.isError).toBeFalsy();
    expect(store.getGoal().goal?.objective).toBe('Ship feature X');
  });

  it('passes completionCriterion, budgets, and replace', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goals: store }));
    await executeTool(tool, ctx({ objective: 'first' }));
    await executeTool(
      tool,
      ctx({
        objective: 'second',
        completionCriterion: 'tests pass',
        budgetLimits: { tokenBudget: 100 },
        replace: true,
      }),
    );
    const goal = store.getGoal().goal!;
    expect(goal.objective).toBe('second');
    expect(goal.completionCriterion).toBe('tests pass');
    expect(goal.budget.tokenBudget).toBe(100);
  });

  it('rejects empty and too-long objectives via the store', async () => {
    const store = makeStore();
    const tool = new CreateGoalTool(fakeAgent({ goals: store }));
    const empty = await executeTool(tool, ctx({ objective: '   ' }));
    expect(empty).toMatchObject({ isError: true });
    expect(empty.output).toContain(ErrorCodes.GOAL_OBJECTIVE_EMPTY);
    const long = await executeTool(tool, ctx({ objective: 'x'.repeat(4001) }));
    expect(long).toMatchObject({ isError: true });
    expect(long.output).toContain(ErrorCodes.GOAL_OBJECTIVE_TOO_LONG);
  });

  it('errors when agent.goals is undefined', async () => {
    const tool = new CreateGoalTool(fakeAgent({ goals: undefined }));
    const result = await executeTool(tool, ctx({ objective: 'work' }));
    expect(result).toMatchObject({ isError: true });
  });

  it('uses the imported markdown description', () => {
    const tool = new CreateGoalTool(fakeAgent());
    expect(tool.description).toContain('Create a durable, structured goal');
  });
});

describe('GetGoalTool', () => {
  it('returns { goal: null } when no goal exists', async () => {
    const store = makeStore();
    const tool = new GetGoalTool(fakeAgent({ goals: store }));
    const result = await executeTool(tool, ctx({}));
    expect(JSON.parse(result.output as string)).toEqual({ goal: null });
  });

  it('returns { goal: null } when agent.goals is undefined', async () => {
    const tool = new GetGoalTool(fakeAgent({ goals: undefined }));
    const result = await executeTool(tool, ctx({}));
    expect(JSON.parse(result.output as string)).toEqual({ goal: null });
  });

  it('returns active goal state with budgets', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { tokenBudget: 100 } });
    const tool = new GetGoalTool(fakeAgent({ goals: store }));
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
    const tool = new GetGoalTool(fakeAgent({ goals: store }));
    let parsed = JSON.parse((await executeTool(tool, ctx({}))).output as string);
    expect(parsed.goal.status).toBe('paused');
    await store.resumeGoal();
    await store.markBlocked({ reason: 'stuck' });
    parsed = JSON.parse((await executeTool(tool, ctx({}))).output as string);
    expect(parsed.goal.status).toBe('blocked');
  });
});

describe('UpdateGoalTool', () => {
  it('accepts only complete and blocked', () => {
    for (const status of ['complete', 'blocked']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status, reason: 'r' }).success).toBe(true);
    }
    for (const status of ['active', 'paused', 'impossible', 'cancelled', 'budget_limited', 'error']) {
      expect(UpdateGoalToolInputSchema.safeParse({ status, reason: 'r' }).success).toBe(false);
    }
  });

  it('requires a non-empty reason', () => {
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'complete' }).success).toBe(false);
    expect(UpdateGoalToolInputSchema.safeParse({ status: 'complete', reason: '' }).success).toBe(
      false,
    );
  });

  it('records a model report without making the goal terminal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const tool = new UpdateGoalTool(fakeAgent({ goals: store }));
    const result = await executeTool(tool, ctx({ status: 'complete', reason: 'done' }));
    expect(result.isError).toBeFalsy();
    const goal = store.getGoal().goal!;
    expect(goal.status).toBe('active');
    expect(goal.lastModelReportStatus).toBe('complete');
  });

  it('returns GOAL_NOT_FOUND when no active goal exists', async () => {
    const store = makeStore();
    const tool = new UpdateGoalTool(fakeAgent({ goals: store }));
    const result = await executeTool(tool, ctx({ status: 'complete', reason: 'done' }));
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain(ErrorCodes.GOAL_NOT_FOUND);
  });
});

describe('goal tools are main-agent-only', () => {
  it('all goal tools return isError on a non-main agent', async () => {
    const store = makeStore();
    const agent = fakeAgent({ type: 'sub', goals: store });
    expect(await executeTool(new CreateGoalTool(agent), ctx({ objective: 'x' }))).toMatchObject({
      isError: true,
    });
    expect(await executeTool(new GetGoalTool(agent), ctx({}))).toMatchObject({ isError: true });
    expect(
      await executeTool(new UpdateGoalTool(agent), ctx({ status: 'complete', reason: 'r' })),
    ).toMatchObject({ isError: true });
  });
});

describe('ToolManager goal tool registration', () => {
  const original = process.env[GOAL_FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[GOAL_FLAG];
    else process.env[GOAL_FLAG] = original;
  });

  function loopToolNames(type: 'main' | 'sub'): readonly string[] {
    const ctxAgent = testAgent({ type });
    // configure() gives the agent a provider so builtin tools can initialize.
    ctxAgent.configure({ tools: ['Read', 'CreateGoal', 'GetGoal', 'UpdateGoal'] });
    // Re-run registration so the gate reads the current flag state.
    ctxAgent.agent.tools.initializeBuiltinTools();
    return ctxAgent.agent.tools.loopTools.map((tool) => tool.name);
  }

  it('omits goal tools when the flag is disabled', () => {
    delete process.env[GOAL_FLAG];
    const names = loopToolNames('main');
    expect(names).not.toContain('CreateGoal');
    expect(names).not.toContain('GetGoal');
    expect(names).not.toContain('UpdateGoal');
  });

  it('exposes goal tools to the main agent when the flag is enabled', () => {
    process.env[GOAL_FLAG] = 'true';
    const names = loopToolNames('main');
    expect(names).toEqual(expect.arrayContaining(['CreateGoal', 'GetGoal', 'UpdateGoal']));
  });

  it('does not expose goal tools to subagents even when enabled', () => {
    process.env[GOAL_FLAG] = 'true';
    const names = loopToolNames('sub');
    expect(names).not.toContain('CreateGoal');
    expect(names).not.toContain('GetGoal');
    expect(names).not.toContain('UpdateGoal');
  });
});

describe('CreateGoalToolInputSchema', () => {
  it('accepts a minimal objective and a full payload', () => {
    expect(CreateGoalToolInputSchema.safeParse({ objective: 'x' }).success).toBe(true);
    expect(
      CreateGoalToolInputSchema.safeParse({
        objective: 'x',
        completionCriterion: 'done',
        budgetLimits: { tokenBudget: 1, turnBudget: 2, wallClockBudgetMs: 3 },
        replace: true,
      }).success,
    ).toBe(true);
  });
});
