import { emptyUsage, type TokenUsage } from '@moonshot-ai/kosong';
import type { LLMChatParams } from '../../src/loop/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  GoalContinuationController,
  type GoalEvaluatorLike,
} from '../../src/agent/goal/continuation';
import {
  GoalEvaluator,
  type GoalEvaluatorInput,
  type GoalEvaluatorResult,
} from '../../src/agent/goal/evaluator';
import type { LLM } from '../../src/loop/llm';
import type { LoopStoppedStepContext } from '../../src/loop/types';
import { SessionGoalStore, type GoalSnapshot, type SessionGoalState } from '../../src/session/goal';

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

function tokens(output: number): TokenUsage {
  return { inputOther: 0, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

function fakeLLM(text: string, usage: TokenUsage = emptyUsage()): LLM {
  return {
    systemPrompt: '',
    modelName: 'judge',
    chat: async ({ onTextDelta }: LLMChatParams) => {
      onTextDelta?.(text);
      return { toolCalls: [], usage };
    },
  } as unknown as LLM;
}

function throwingLLM(): LLM {
  return {
    systemPrompt: '',
    modelName: 'judge',
    chat: async () => {
      throw new Error('judge unavailable');
    },
  } as unknown as LLM;
}

interface AppendedMessage {
  readonly origin: { kind: string; name?: string };
}

function controllerAgent(opts: { goals: SessionGoalStore }): {
  agent: Agent;
  messages: AppendedMessage[];
} {
  const messages: AppendedMessage[] = [];
  const agent = {
    type: 'main',
    goals: opts.goals,
    kimiConfig: undefined,
    injection: {
      injectGoal: async () => {},
    },
    context: {
      appendUserMessage: (_content: unknown, origin: AppendedMessage['origin']) => {
        messages.push({ origin });
      },
      get messages() {
        return [];
      },
    },
  } as unknown as Agent;
  return { agent, messages };
}

function stoppedCtx(stepNumber: number): LoopStoppedStepContext {
  return { stepNumber, llm: fakeLLM('{}') } as unknown as LoopStoppedStepContext;
}

function factoryOf(impl: (input: GoalEvaluatorInput) => GoalEvaluatorResult): () => GoalEvaluatorLike {
  return () => ({ evaluate: async (input) => impl(input) });
}

const goalInput = (): GoalEvaluatorInput => ({
  goal: {
    objective: 'work',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: { turnBudget: null, tokenBudget: null, wallClockBudgetMs: null },
  } as unknown as GoalSnapshot,
  messages: [],
  signal: new AbortController().signal,
});

describe('GoalEvaluator', () => {
  it('parses valid JSON into a typed result', async () => {
    const evaluator = new GoalEvaluator({
      llm: fakeLLM('{"verdict":"complete","reason":"done","evidence":[{"summary":"tests pass"}]}'),
    });
    const result = await evaluator.evaluate(goalInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toBe('complete');
      expect(result.reason).toBe('done');
      expect(result.evidence).toEqual([{ summary: 'tests pass', detail: undefined, source: undefined }]);
    }
  });

  it('extracts JSON embedded in surrounding prose', async () => {
    const evaluator = new GoalEvaluator({
      llm: fakeLLM('Here is my verdict: {"verdict":"continue","reason":"more to do"} done'),
    });
    const result = await evaluator.evaluate(goalInput());
    expect(result.ok && result.verdict).toBe('continue');
  });

  it('returns an error for invalid JSON', async () => {
    const evaluator = new GoalEvaluator({ llm: fakeLLM('not json at all') });
    const result = await evaluator.evaluate(goalInput());
    expect(result.ok).toBe(false);
  });

  it('returns an error when the judge call throws', async () => {
    const evaluator = new GoalEvaluator({ llm: throwingLLM() });
    const result = await evaluator.evaluate(goalInput());
    expect(result.ok).toBe(false);
  });

  it('reports the judge token usage', async () => {
    const evaluator = new GoalEvaluator({
      llm: fakeLLM('{"verdict":"continue","reason":"go"}', tokens(42)),
    });
    const result = await evaluator.evaluate(goalInput());
    expect(result.usage.output).toBe(42);
  });

  it('can be constructed with an injected judge LLM', async () => {
    const judge = fakeLLM('{"verdict":"complete","reason":"ok"}');
    const evaluator = new GoalEvaluator({ llm: judge });
    expect((await evaluator.evaluate(goalInput())).ok).toBe(true);
  });

  it('surfaces the live counters and a stop-condition check to the judge', async () => {
    let seenPrompt = '';
    const capturingLLM = {
      systemPrompt: '',
      modelName: 'judge',
      chat: async ({ messages, onTextDelta }: LLMChatParams) => {
        const first = messages[0]?.content[0];
        seenPrompt = first !== undefined && first.type === 'text' ? first.text : '';
        onTextDelta?.('{"verdict":"continue","reason":"go"}');
        return { toolCalls: [], usage: emptyUsage() };
      },
    } as unknown as LLM;
    const evaluator = new GoalEvaluator({ llm: capturingLLM });
    await evaluator.evaluate({
      goal: {
        objective: 'work',
        turnsUsed: 7,
        tokensUsed: 1234,
        wallClockMs: 65_000,
        budget: { turnBudget: 20, tokenBudget: null, wallClockBudgetMs: null },
      } as unknown as GoalSnapshot,
      messages: [],
      signal: new AbortController().signal,
    });
    expect(seenPrompt).toContain('Progress so far: 7 continuation turn');
    expect(seenPrompt).toContain('1234 tokens');
    expect(seenPrompt).toContain('turns 7/20');
    expect(seenPrompt).toContain('stop condition stated in the objective');
  });
});

describe('GoalContinuationController with evaluator', () => {
  beforeEach(() => {
    process.env[GOAL_FLAG] = 'true';
  });
  afterEach(() => {
    delete process.env[GOAL_FLAG];
  });

  async function runWith(
    store: SessionGoalStore,
    factory: () => GoalEvaluatorLike,
    step = 1,
  ): Promise<{ result: { continue: boolean }; messages: AppendedMessage[] }> {
    const { agent, messages } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0, createEvaluator: factory });
    const result = await c.shouldContinueAfterStop(stoppedCtx(step));
    return { result, messages };
  }

  it('completes and clears the goal on a complete verdict', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { result } = await runWith(store, factoryOf(() => ({ ok: true, verdict: 'complete', reason: 'done', usage: emptyUsage() })));
    expect(result).toEqual({ continue: false });
    // `complete` is transient — the goal box disappears.
    expect(store.getGoal().goal).toBeNull();
  });

  it('marks blocked (resumable) and stops on a blocked verdict', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { result } = await runWith(store, factoryOf(() => ({ ok: true, verdict: 'blocked', reason: 'stuck', usage: emptyUsage() })));
    expect(result).toEqual({ continue: false });
    expect(store.getGoal().goal!.status).toBe('blocked');
  });

  it('appends a continuation prompt on a continue verdict', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { result, messages } = await runWith(store, factoryOf(() => ({ ok: true, verdict: 'continue', reason: 'more', usage: emptyUsage() })));
    expect(result).toEqual({ continue: true, resetStepBudget: true });
    expect(messages.at(-1)!.origin).toEqual({ kind: 'system_trigger', name: 'goal_continuation' });
    expect(store.getGoal().goal!.status).toBe('active');
  });

  it('increments the no-progress counter on a no_progress verdict', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await runWith(store, factoryOf(() => ({ ok: true, verdict: 'no_progress', reason: 'spinning', usage: emptyUsage() })));
    expect(store.getGoal().goal!.consecutiveNoProgressTurns).toBe(1);
  });

  it('marks blocked when the no-progress limit is reached', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { noProgressTurnLimit: 1 } });
    const { result } = await runWith(store, factoryOf(() => ({ ok: true, verdict: 'no_progress', reason: 'spinning', usage: emptyUsage() })));
    expect(result).toEqual({ continue: false });
    expect(store.getGoal().goal!.status).toBe('blocked');
  });

  it('records evaluator failures without crashing and continues within the failure limit', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    const { result } = await runWith(store, factoryOf(() => ({ ok: false, error: 'bad json', usage: emptyUsage() })));
    expect(result).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.consecutiveFailureTurns).toBe(1);
    expect(store.getGoal().goal!.status).toBe('active');
  });

  it('marks blocked when the evaluator failure limit is reached', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { failureTurnLimit: 1 } });
    const { result } = await runWith(store, factoryOf(() => ({ ok: false, error: 'bad json', usage: emptyUsage() })));
    expect(result).toEqual({ continue: false });
    expect(store.getGoal().goal!.status).toBe('blocked');
  });

  it('counts evaluator token usage toward the goal token budget', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await runWith(store, factoryOf(() => ({ ok: true, verdict: 'continue', reason: 'go', usage: tokens(30) })));
    expect(store.getGoal().goal!.tokensUsed).toBe(30);
  });

  it('lets evaluator token usage trigger a blocked (budget) stop', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work', budgetLimits: { tokenBudget: 20 } });
    const { result } = await runWith(store, factoryOf(() => ({ ok: true, verdict: 'continue', reason: 'go', usage: tokens(50) })));
    // Evaluator usage (50) exceeds the 20-token budget -> blocked (resumable), stop.
    expect(result).toEqual({ continue: false });
    expect(store.getGoal().goal!.status).toBe('blocked');
  });

  it('passes the model self-report to the evaluator as evidence', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.recordModelReport({ requestedStatus: 'complete', reason: 'i think im done' });
    let seen: GoalEvaluatorInput['modelReport'];
    await runWith(
      store,
      factoryOf((input) => {
        seen = input.modelReport;
        return { ok: true, verdict: 'continue', reason: 'verify more', usage: emptyUsage() };
      }),
    );
    expect(seen?.status).toBe('complete');
  });

  it('does not end the goal on a model report alone when the evaluator says continue', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    await store.recordModelReport({ requestedStatus: 'complete', reason: 'done' });
    const { result } = await runWith(store, factoryOf(() => ({ ok: true, verdict: 'continue', reason: 'not yet', usage: emptyUsage() })));
    expect(result).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.status).toBe('active');
  });

  it('decides between continuing and stopping across two stopped steps', async () => {
    const store = makeStore();
    await store.createGoal({ objective: 'work' });
    let calls = 0;
    const factory = factoryOf(() => {
      calls += 1;
      return calls === 1
        ? { ok: true, verdict: 'continue', reason: 'more', usage: emptyUsage() }
        : { ok: true, verdict: 'complete', reason: 'done', usage: emptyUsage() };
    });
    const { agent } = controllerAgent({ goals: store });
    const c = new GoalContinuationController(agent, { startedAt: 0, createEvaluator: factory });

    expect(await c.shouldContinueAfterStop(stoppedCtx(1))).toEqual({ continue: true, resetStepBudget: true });
    expect(store.getGoal().goal!.status).toBe('active');
    expect(await c.shouldContinueAfterStop(stoppedCtx(2))).toEqual({ continue: false });
    // Completion clears the goal.
    expect(store.getGoal().goal).toBeNull();
  });
});
