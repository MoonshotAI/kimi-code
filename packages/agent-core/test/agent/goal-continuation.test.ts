import { emptyUsage } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  GoalContinuationController,
  type GoalEvaluatorLike,
} from '../../src/agent/goal/continuation';
import type { GoalEvaluatorVerdict } from '../../src/agent/goal/evaluator';
import type { LoopStoppedStepContext } from '../../src/loop/types';

/** A fake evaluator factory returning a fixed verdict. */
function fixedEvaluator(verdict: GoalEvaluatorVerdict, reason = 'judge'): () => GoalEvaluatorLike {
  return () => ({
    evaluate: async () => ({ ok: true, verdict, reason, usage: emptyUsage() }),
  });
}
import { HookEngine } from '../../src/session/hooks';
import {
  DEFAULT_GOAL_TURN_BUDGET,
  SessionGoalStore,
  type SessionGoalState,
} from '../../src/session/goal';
import { testAgent } from './harness/agent';

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

const GOAL_FLAG = 'KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND';

function makeStore(): SessionGoalStore {
  let state: SessionGoalState | undefined;
  return new SessionGoalStore({
    sessionId: 'test',
    readState: () => state,
    writeState: async (next) => {
      state = next;
    },
  });
}

interface AppendedMessage {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
  readonly origin: { kind: string; name?: string };
}

function controllerAgent(opts: {
  type?: 'main' | 'sub';
  goals?: SessionGoalStore;
  maxStepsPerTurn?: number;
}): { agent: Agent; messages: AppendedMessage[] } {
  const messages: AppendedMessage[] = [];
  const agent = {
    type: opts.type ?? 'main',
    goals: opts.goals,
    kimiConfig:
      opts.maxStepsPerTurn !== undefined
        ? { loopControl: { maxStepsPerTurn: opts.maxStepsPerTurn } }
        : undefined,
    context: {
      appendUserMessage: (content: AppendedMessage['content'], origin: AppendedMessage['origin']) => {
        messages.push({ content, origin });
      },
    },
  } as unknown as Agent;
  return { agent, messages };
}

function stoppedCtx(stepNumber: number): LoopStoppedStepContext {
  return { stepNumber } as unknown as LoopStoppedStepContext;
}

function maxStepsCtx(maxSteps: number) {
  return { stepNumber: maxSteps, maxSteps, signal: new AbortController().signal } as never;
}

describe('GoalContinuationController decisions', () => {
  beforeEach(() => {
    process.env[GOAL_FLAG] = 'true';
  });
  afterEach(() => {
    delete process.env[GOAL_FLAG];
  });

  it('does not continue when the flag is disabled', async () => {
    delete process.env[GOAL_FLAG];
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0 });
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: false });
  });

  it('does not continue for a subagent', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { agent } = controllerAgent({ type: 'sub', goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0 });
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: false });
  });

  it('does not continue when there is no active goal', async () => {
    const store = makeStore();
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0 });
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: false });
  });

  it('continues an active goal, increments the turn, and appends a goal_continuation prompt', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { agent, messages } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('continue'),
    });

    const result = await c.shouldContinueAfterStop(stoppedCtx(1));

    expect(result).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.turnsUsed).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.origin).toEqual({ kind: 'system_trigger', name: 'goal_continuation' });
  });

  it('does not continue a paused goal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.pauseGoal();
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0 });
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: false });
  });

  it('stops the loop at a token budget with a single wrap-up continuation', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { tokenBudget: 10 } });
    await store.recordTokenUsage({ tokenDelta: 10, agentId: 'main', agentType: 'main', source: 'agent_step' });
    const { agent, messages } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0 });

    // First stop: budget reached -> wrap-up continuation, status becomes terminal.
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.status).toBe('budget_limited');
    expect(messages.at(-1)!.origin).toEqual({ kind: 'system_trigger', name: 'goal_continuation' });

    // Second stop: terminal -> stop, no further continuation.
    expect(await c.shouldContinueAfterStop(stoppedCtx(2))).toEqual({ continue: false });
  });

  it('stops the loop at a turn budget', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { turnBudget: 1 } });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0 });
    // incrementTurn brings turnsUsed to 1 == turnBudget -> budget reached.
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.status).toBe('budget_limited');
  });

  it('records live wall-clock time before the budget check', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { wallClockBudgetMs: 1000 } });
    let nowValue = 0;
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0, now: () => nowValue });
    nowValue = 1500; // 1.5s elapsed > 1s budget
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.wallClockMs).toBe(1500);
    expect(store.getGoal().goal!.status).toBe('budget_limited');
  });

  it('resets the step budget on each continuation so maxStepsPerTurn bounds a segment', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('continue'),
    });
    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({
      continue: true,
      resetStepBudget: true,
    });
  });

  it('treats a mid-segment step cap as a goal checkpoint, not a fatal error', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('continue'),
    });
    // An active goal hitting the cap continues with a fresh segment budget.
    expect(await c.shouldContinueOnMaxSteps(maxStepsCtx(100))).toEqual({
      continue: true,
      resetStepBudget: true,
    });
    expect(store.getGoal().goal!.status).toBe('active');
    expect(store.getGoal().goal!.turnsUsed).toBe(1);
  });

  it('lets the evaluator end the goal at the step cap', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('complete'),
    });
    expect(await c.shouldContinueOnMaxSteps(maxStepsCtx(100))).toEqual({ continue: false });
    expect(store.getGoal().goal!.status).toBe('complete');
  });

  it('returns undefined at the cap for a non-goal turn so the loop still throws', async () => {
    const store = makeStore();
    const { agent } = controllerAgent({ goals: store }); // no active goal
    const c = new GoalContinuationController(agent, { startedAt: 0 });
    expect(await c.shouldContinueOnMaxSteps(maxStepsCtx(100))).toBeUndefined();
  });

  it('stops at the step cap when a hard budget is already reached', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { turnBudget: 1 } });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('continue'),
    });
    // incrementTurn pushes turnsUsed to 1 == turnBudget -> budget_limited wrap-up.
    expect(await c.shouldContinueOnMaxSteps(maxStepsCtx(2))).toEqual({
      continue: true,
      resetStepBudget: true,
    });
    expect(store.getGoal().goal!.status).toBe('budget_limited');
  });

  it('stops gracefully when the cap is hit again after a budget wrap-up made the goal terminal', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { turnBudget: 1 } });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('continue'),
    });
    // First cap: turnsUsed hits the budget -> budget_limited wrap-up segment.
    expect(await c.shouldContinueOnMaxSteps(maxStepsCtx(2))).toEqual({
      continue: true,
      resetStepBudget: true,
    });
    expect(store.getGoal().goal!.status).toBe('budget_limited');
    // The model keeps calling tools instead of summarizing and hits the cap
    // again. The goal is already terminal, but goal continuation drove this
    // turn, so the cap must stop gracefully -- never throw.
    expect(await c.shouldContinueOnMaxSteps(maxStepsCtx(2))).toEqual({ continue: false });
  });

  it('the default turn budget caps an evaluator that always says continue', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' }); // no explicit budget -> DEFAULT_GOAL_TURN_BUDGET
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, {
      startedAt: 0,
      createEvaluator: fixedEvaluator('continue'),
    });

    let iterations = 0;
    let result = { continue: true };
    while (result.continue && iterations < 100) {
      iterations += 1;
      result = await c.shouldContinueAfterStop(stoppedCtx(iterations));
    }

    expect(result.continue).toBe(false);
    expect(store.getGoal().goal!.status).toBe('budget_limited');
    expect(store.getGoal().goal!.turnsUsed).toBeLessThanOrEqual(DEFAULT_GOAL_TURN_BUDGET);
  });

  it('finalizeWallClock records the trailing interval', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    let nowValue = 0;
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0, now: () => nowValue });
    nowValue = 750;
    await c.finalizeWallClock();
    expect(store.getGoal().goal!.wallClockMs).toBe(750);
  });
});

describe('GoalContinuationController turn integration', () => {
  const original = process.env[GOAL_FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[GOAL_FLAG];
    else process.env[GOAL_FLAG] = original;
  });

  it('auto-continues the main agent and stops at the turn budget', async () => {
    process.env[GOAL_FLAG] = 'true';
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { turnBudget: 1 } });
    const ctx = testAgent({ type: 'main', goals: store });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'step 1' });
    ctx.mockNextResponse({ type: 'text', text: 'wrap up' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls.length).toBe(2); // initial step + one wrap-up continuation
    expect(store.getGoal().goal!.status).toBe('budget_limited');
  });

  it('does not auto-continue a subagent', async () => {
    process.env[GOAL_FLAG] = 'true';
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const ctx = testAgent({ type: 'sub', goals: store });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls.length).toBe(1);
    expect(store.getGoal().goal!.turnsUsed).toBe(0);
  });

  it('does not continue when the flag is disabled', async () => {
    delete process.env[GOAL_FLAG];
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const ctx = testAgent({ type: 'main', goals: store });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls.length).toBe(1);
  });

  it('runs more total steps than maxStepsPerTurn without a fatal error', async () => {
    process.env[GOAL_FLAG] = 'true';
    const store = makeStore();
    // turnBudget 2 is the real ceiling; maxStepsPerTurn 2 must NOT cap the goal.
    await store.createGoal({ objective: 'work', budgetLimits: { turnBudget: 2 } });
    const ctx = testAgent({
      type: 'main',
      goals: store,
      goalEvaluatorFactory: fixedEvaluator('continue'),
      initialConfig: { providers: {}, loopControl: { maxStepsPerTurn: 2 } },
    });
    ctx.configure();
    // 3 model steps total > maxStepsPerTurn (2): the old whole-goal cap would
    // have thrown loop.max_steps_exceeded before the third step.
    ctx.mockNextResponse({ type: 'text', text: 'step 1' });
    ctx.mockNextResponse({ type: 'text', text: 'step 2' });
    ctx.mockNextResponse({ type: 'text', text: 'wrap up' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    const events = await ctx.untilTurnEnd();

    expect(JSON.stringify(events)).not.toContain('loop.max_steps_exceeded');
    expect(ctx.llmCalls.length).toBe(3);
    // The goal stopped via its own turn budget, not a runtime error.
    expect(store.getGoal().goal!.status).toBe('budget_limited');
  });

  it('marks an active goal error when the turn fails', async () => {
    process.env[GOAL_FLAG] = 'true';
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const ctx = testAgent({
      type: 'main',
      goals: store,
      generate: async () => {
        throw new Error('boom');
      },
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    expect(store.getGoal().goal!.status).toBe('error');
  });

  it('marks an active goal interrupted when the turn is cancelled', async () => {
    process.env[GOAL_FLAG] = 'true';
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const ctx = testAgent({
      type: 'main',
      goals: store,
      generate: async (_p, _s, _t, _h, _cb, options) => {
        signalStarted();
        await waitForAbort((options as { signal?: AbortSignal } | undefined)?.signal);
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });
    ctx.configure();

    const ended = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await started;
    await ctx.rpc.cancel({});
    await ended;

    expect(store.getGoal().goal!.status).toBe('interrupted');
  });

  it('gives the external Stop hook one continuation without capping goal continuations', async () => {
    process.env[GOAL_FLAG] = 'true';
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { turnBudget: 2 } });
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        matcher: '',
        command: `node -e "process.stderr.write('keep going'); process.exit(2)"`,
      },
    ]);
    const ctx = testAgent({
      type: 'main',
      goals: store,
      hookEngine,
      goalEvaluatorFactory: fixedEvaluator('continue'),
    });
    ctx.configure();
    for (let i = 0; i < 5; i++) {
      ctx.mockNextResponse({ type: 'text', text: `step ${String(i)}` });
    }

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work' }] });
    await ctx.untilTurnEnd();

    const names = ctx.agent.context.data().history.map((m) => {
      const origin = m.origin as { name?: string } | undefined;
      return origin?.name;
    });
    // The Stop hook fired once, and goal continuations still ran afterward.
    expect(names).toContain('stop_hook');
    expect(names).toContain('goal_continuation');
    expect(store.getGoal().goal!.status).toBe('budget_limited');
  });
});
