import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature, useAgent, type Feature } from '@moonshot-ai/agent-core/app/index';
import {
  createUserEntry,
  type HistoryMessage,
  type ToolMeta,
  type UserMeta,
} from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type ToolCall,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome, TokenUsage } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester, TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';

import {
  interaction,
  InteractionRef,
  type Interaction,
  type Interactions,
} from '#/features/interaction/index';
import {
  createGoal,
  GOAL_ALREADY_EXISTS,
  GOAL_BUDGET_STOP_REMINDER,
  GOAL_BUDGET_STOP_REMINDER_NAME,
  GOAL_BUDGET_TOOLS_REJECTED_MESSAGE,
  GOAL_CANCELLED_REMINDER_NAME,
  GOAL_CONTINUATION_PROMPT,
  GOAL_CREATE,
  GOAL_NOT_FOUND,
  GOAL_OBJECTIVE_EMPTY,
  GOAL_OBJECTIVE_TOO_LONG,
  GOAL_REMIND_KEY,
  GOAL_STATUS_INVALID,
  GOAL_UPDATE,
  GoalRef,
  isGoalContinuationOrigin,
  type GoalEvent,
  type GoalFace,
  type GoalStartApprovalResponse,
  type GoalUpdatedEvent,
} from '#/features/goal/index';
import {
  createHarness,
  featureWriterOf,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

let queue: ScriptStep[] = [];
let callSeq = 0;

const USAGE: TokenUsage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls), usage: USAGE };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function createMockRequester(): LoopLlmRequester {
  return scriptedRequester(async () => {
    await tick();
    const out = queue.shift() ?? { text: 'done' };
    if ('toolCall' in out) {
      return textOutcome('', [
        {
          type: 'function',
          id: `call-${(callSeq += 1)}`,
          name: out.toolCall.name,
          arguments: out.toolCall.arguments,
        },
      ]);
    }
    return textOutcome(out.text);
  });
}

function bindTestTools(): Feature {
  return createFeature('test-tools', {
    agent: () => {
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'Read ok' }] }),
      });
    },
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface GoalTestEnv {
  readonly harness: Harness;
  readonly goalFeature: Feature<void, GoalUpdatedEvent>;
  readonly turnDones: Array<{ turnId: number; outcome: TurnOutcome }>;
  runTurn(text?: string): Promise<void>;
  waitForTurns(count: number): Promise<void>;
  settle(): Promise<void>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
  main(): Agent;
  goal(): GoalFace;
  interactions(): Interactions;
  messages(): Promise<readonly HistoryMessage[]>;
}

async function startGoalTest(options?: {
  readonly now?: () => number;
  readonly requester?: LoopLlmRequester;
  readonly maxSteps?: number;
  readonly seed?: (harness: Harness) => Promise<void>;
}): Promise<GoalTestEnv> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const goalFeature = createGoal(options?.now === undefined ? {} : { now: options.now });
  const goalRefs = new Map<string, Readonly<ShallowRef<GoalFace | undefined>>>();
  const goalProbe = createFeature('goal-probe', {
    agent: () => {
      goalRefs.set(useAgent().id, useInject(GoalRef));
    },
  });
  let interactionsRef: Readonly<ShallowRef<Interactions | undefined>> | undefined;
  const interactionProbe = createFeature('interaction-probe', {
    session: () => {
      interactionsRef = useInject(InteractionRef);
    },
  });
  await harness.app.features.add(interaction);
  await harness.app.features.add(interactionProbe);
  await harness.app.features.add(goalFeature);
  await harness.app.features.add(goalProbe);
  await harness.app.features.add(bindTestTools());
  const requester = options?.requester ?? createMockRequester();
  let session = await harness.app.create({ sessionId: 'sess' });
  await options?.seed?.(harness);
  const openMain = async (): Promise<Agent> => {
    const agent = await harness.ensureAgent(session, MAIN_AGENT_ID, {
      systemPrompt: 'main-host',
      ...(options?.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    });
    setRequester(harness, 'sess', MAIN_AGENT_ID, requester);
    return agent;
  };
  let main = await openMain();
  const turnDones: Array<{ turnId: number; outcome: TurnOutcome }> = [];
  const trackTurns = (agent: Agent): void => {
    agent.loop.subscribe((event) => {
      if (event.type === 'turn.ended') {
        turnDones.push({ turnId: event.turnId, outcome: event.outcome });
      }
    });
  };
  trackTurns(main);
  await tick();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i += 1) await tick();
  };
  const waitForTurns = async (count: number): Promise<void> => {
    for (let i = 0; i < 400 && turnDones.length < count; i += 1) await tick();
    expect(turnDones.length).toBeGreaterThanOrEqual(count);
    await main.flush();
  };
  const runTurn = async (text = 'go'): Promise<void> => {
    const before = turnDones.length;
    main.loop.submit(user(text));
    await waitForTurns(before + 1);
  };
  const remount = async (): Promise<void> => {
    await harness.app.close('sess');
    session = await harness.app.create({ sessionId: 'sess' });
    main = await openMain();
    trackTurns(main);
    await tick();
  };
  const dispose = async (): Promise<void> => {
    await harness.close();
  };
  const goal = (): GoalFace => {
    const face = goalRefs.get(MAIN_AGENT_ID)?.value;
    if (face === undefined) throw new Error('goal facade is not exposed');
    return face;
  };
  const interactions = (): Interactions => {
    const value = interactionsRef?.value;
    if (value === undefined) throw new Error('interaction facade is not exposed');
    return value;
  };
  const messages = async (): Promise<readonly HistoryMessage[]> => {
    await main.flush();
    return main.view.getState().messages;
  };
  return {
    harness,
    goalFeature,
    turnDones,
    runTurn,
    waitForTurns,
    settle,
    remount,
    dispose,
    main: () => main,
    goal,
    interactions,
    messages,
  };
}

function toolResultTexts(messages: readonly HistoryMessage[]): string[] {
  return messages
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(messages: readonly HistoryMessage[]): boolean[] {
  return messages
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function goalReminders(messages: readonly HistoryMessage[], key: string): string[] {
  return messages
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === key)
    .map((entry) => extractText(entry.message));
}

function reminderBody(text: string): string {
  const match = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>$/.exec(text);
  return match?.[1] ?? text;
}

function readCall(): ScriptStep {
  return { toolCall: { name: 'Read', arguments: '{}' } };
}

function updateGoalCall(status: string): ScriptStep {
  return { toolCall: { name: 'UpdateGoal', arguments: JSON.stringify({ status }) } };
}

afterEach(() => {
  queue = [];
});

describe('goal feature', () => {
  it('creates, transitions, and clears goals through the facade with lifecycle events', async () => {
    const env = await startGoalTest();
    const events: GoalUpdatedEvent[] = [];
    env.harness.app.on(env.goalFeature, 'goal.updated', (event) => {
      events.push(event);
    });
    const goal = env.goal();

    const created = await goal.createGoal({
      objective: 'Ship feature X',
      completionCriterion: ' tests pass ',
    });
    expect(created.status).toBe('active');
    expect(created.completionCriterion).toBe('tests pass');
    expect(created.budget).toMatchObject({
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      overBudget: false,
    });
    expect(goal.getGoal().goal?.goalId).toBe(created.goalId);

    const paused = await goal.pauseGoal({ reason: 'break' });
    expect(paused.status).toBe('paused');
    expect(paused.terminalReason).toBe('break');
    expect((await goal.pauseGoal()).status).toBe('paused');

    const resumed = await goal.resumeGoal();
    expect(resumed.status).toBe('active');
    expect(resumed.terminalReason).toBeUndefined();

    const blocked = await goal.markBlocked({ reason: 'need creds' });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.terminalReason).toBe('need creds');
    expect((await goal.resumeGoal()).status).toBe('active');

    const completed = await goal.markComplete({ reason: 'done' }, 'model');
    expect(completed?.status).toBe('complete');
    expect(goal.getGoal().goal).toBeNull();

    expect(events.map((event) => event.change?.kind)).toEqual([
      undefined,
      'lifecycle',
      'lifecycle',
      'lifecycle',
      'lifecycle',
      'completion',
      undefined,
    ]);
    expect(events.find((event) => event.change?.kind === 'completion')?.change).toMatchObject({
      status: 'complete',
      reason: 'done',
      actor: 'model',
    });
    expect(events.at(-1)?.snapshot).toBeNull();

    await goal.createGoal({ objective: 'second' });
    const removed = await goal.cancelGoal({});
    expect(removed.status).toBe('active');
    expect(goal.getGoal().goal).toBeNull();
    await expect(goal.cancelGoal()).rejects.toMatchObject({ code: GOAL_NOT_FOUND });

    await env.dispose();
  });

  it('validates objectives, rejects duplicates, and replaces through the facade', async () => {
    const env = await startGoalTest();
    const goal = env.goal();

    await expect(goal.createGoal({ objective: '   ' })).rejects.toMatchObject({
      code: GOAL_OBJECTIVE_EMPTY,
    });
    await expect(goal.createGoal({ objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: GOAL_OBJECTIVE_TOO_LONG,
    });

    const truncated = await goal.createGoal({
      objective: 'work',
      completionCriterion: 'c'.repeat(4001),
    });
    expect(truncated.completionCriterion).toBe('c'.repeat(4000));

    await expect(goal.createGoal({ objective: 'other' })).rejects.toMatchObject({
      code: GOAL_ALREADY_EXISTS,
    });
    await goal.pauseGoal();
    await expect(goal.createGoal({ objective: 'other' })).rejects.toMatchObject({
      code: GOAL_ALREADY_EXISTS,
    });
    await goal.resumeGoal();
    await goal.markBlocked({ reason: 'stuck' });
    await expect(goal.createGoal({ objective: 'other' })).rejects.toMatchObject({
      code: GOAL_ALREADY_EXISTS,
    });
    await expect(goal.pauseGoal()).rejects.toMatchObject({ code: GOAL_STATUS_INVALID });

    const replaced = await goal.createGoal({ objective: 'other', replace: true });
    expect(replaced.goalId).not.toBe(truncated.goalId);
    expect(goal.getGoal().goal?.objective).toBe('other');

    await env.dispose();
  });

  it('accounts turns and tokens while active and reports budgets through the facade', async () => {
    const env = await startGoalTest();
    const goal = env.goal();
    await goal.createGoal({ objective: 'bounded' });
    await goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } });

    queue = [{ text: 'first slice' }];
    await env.runTurn();
    await env.settle();

    expect(env.turnDones).toHaveLength(1);
    expect(goal.getGoal().goal).toMatchObject({
      status: 'blocked',
      turnsUsed: 1,
      tokensUsed: 5,
      terminalReason: 'Blocked after goal budget reached: turn budget 1',
    });

    await goal.resumeGoal();
    const budgeted = await goal.setBudgetLimits({
      budgetLimits: { turnBudget: 10, tokenBudget: 100, wallClockBudgetMs: 60_000 },
    });
    expect(budgeted.budget).toMatchObject({
      tokenBudget: 100,
      turnBudget: 10,
      wallClockBudgetMs: 60_000,
      remainingTokens: 95,
      remainingTurns: 9,
      overBudget: false,
    });

    const exhausted = await goal.setBudgetLimits({ budgetLimits: { turnBudget: 1 } });
    expect(exhausted.status).toBe('blocked');
    expect(exhausted.terminalReason).toBe('Blocked after goal budget reached: turn budget 1');

    await env.dispose();
  });

  it('runs continuation turns until the model completes the goal', async () => {
    const env = await startGoalTest();
    const goal = env.goal();
    await goal.createGoal({ objective: 'ship it' });

    queue = [
      { text: 'slice one' },
      updateGoalCall('complete'),
      { text: 'final summary' },
    ];
    await env.runTurn();
    await env.waitForTurns(3);
    await env.settle();

    const messages = await env.messages();
    const continuations = messages.filter((entry) =>
      isGoalContinuationOrigin(entry.meta?.origin),
    );
    expect(continuations).toHaveLength(1);
    expect(extractText(continuations[0]!.message)).toBe(GOAL_CONTINUATION_PROMPT);

    const results = toolResultTexts(messages);
    expect(results.at(-1)).toContain('Goal completed successfully.');
    expect(results.at(-1)).toContain('Worked 2 turns');
    expect(results.at(-1)).toContain('Write a concise final message for the user.');

    expect(env.turnDones).toHaveLength(3);
    expect(goal.getGoal().goal).toBeNull();

    await env.dispose();
  });

  it('blocks on the token budget mid-turn, rejects tools in the grace turn, and injects the budget-stop reminder', async () => {
    const env = await startGoalTest();
    const goal = env.goal();
    await goal.createGoal({ objective: 'token bounded' });
    await goal.setBudgetLimits({ budgetLimits: { tokenBudget: 10 } });

    queue = [readCall(), readCall(), readCall(), { text: 'final' }];
    await env.runTurn();
    await env.settle();

    expect(goal.getGoal().goal).toMatchObject({
      status: 'blocked',
      tokensUsed: 10,
      terminalReason: 'Blocked after goal budget reached: token budget 10',
    });
    expect(env.turnDones.at(-1)?.outcome.type).toBe('done');
    expect(queue).toHaveLength(1);
    const messages = await env.messages();
    expect(toolResultTexts(messages)).toContain(GOAL_BUDGET_TOOLS_REJECTED_MESSAGE);
    const stopReminders = goalReminders(messages, GOAL_BUDGET_STOP_REMINDER_NAME);
    expect(stopReminders).toHaveLength(1);
    expect(reminderBody(stopReminders[0]!)).toBe(GOAL_BUDGET_STOP_REMINDER);

    await env.dispose();
  });

  it('enforces the wall-clock deadline and persists elapsed time across remount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let now = 0;
      const env = await startGoalTest({ now: () => now });
      const goal = env.goal();
      await goal.createGoal({ objective: 'time bounded' });
      await goal.setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 10_000 } });

      now = 3_000;
      await env.remount();
      const restored = env.goal();
      expect(restored.getGoal().goal).toMatchObject({
        status: 'paused',
        terminalReason: 'Paused after agent closed',
        wallClockMs: 3_000,
      });
      expect(restored.getGoal().goal?.budget.remainingWallClockMs).toBe(7_000);

      await restored.resumeGoal();
      now = 9_999;
      await vi.advanceTimersByTimeAsync(6_999);
      expect(restored.getGoal().goal?.status).toBe('active');
      now = 10_000;
      await vi.advanceTimersByTimeAsync(1);
      await env.settle();
      expect(restored.getGoal().goal).toMatchObject({
        status: 'blocked',
        wallClockMs: 10_000,
        terminalReason: 'Blocked after goal budget reached: wall-clock budget 10000ms',
      });

      await env.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the live turn when the wall-clock budget expires mid-turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let now = 0;
      let llmSignal: AbortSignal | undefined;
      const blockingRequester: LoopLlmRequester = {
        with: () => blockingRequester,
        request: (part) => part as unknown as LlmRequest,
        generate: (_rest, { signal }) =>
          new Promise((_resolve, reject) => {
            llmSignal = signal;
            signal.addEventListener(
              'abort',
              () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              },
              { once: true },
            );
          }),
      };
      const env = await startGoalTest({ now: () => now, requester: blockingRequester });
      const goal = env.goal();
      await goal.createGoal({ objective: 'interrupted by time' });
      await goal.setBudgetLimits({ budgetLimits: { wallClockBudgetMs: 1_000 } });

      env.main().loop.submit(user('start work'));
      for (let i = 0; i < 200 && llmSignal === undefined; i += 1) await tick();
      expect(llmSignal).toBeDefined();

      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await env.waitForTurns(1);
      expect(llmSignal?.aborted).toBe(true);
      expect(goal.getGoal().goal).toMatchObject({
        status: 'blocked',
        wallClockMs: 1_000,
        terminalReason: 'Blocked after goal budget reached: wall-clock budget 1000ms',
      });

      await env.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores goal state on remount and pauses an active goal on agent close', async () => {
    const env = await startGoalTest();
    const goal = env.goal();
    await goal.createGoal({ objective: 'persist me', completionCriterion: 'tests pass' });
    await goal.setBudgetLimits({ budgetLimits: { turnBudget: 1, tokenBudget: 100 } });

    queue = [{ text: 'slice' }];
    await env.runTurn();
    await env.settle();
    expect(goal.getGoal().goal).toMatchObject({ status: 'blocked', turnsUsed: 1, tokensUsed: 5 });

    await env.remount();
    expect(env.goal().getGoal().goal).toMatchObject({
      objective: 'persist me',
      completionCriterion: 'tests pass',
      status: 'blocked',
      turnsUsed: 1,
      tokensUsed: 5,
      budget: { turnBudget: 1, tokenBudget: 100 },
    });

    await env.goal().resumeGoal();
    await env.remount();
    expect(env.goal().getGoal().goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after agent closed',
    });

    await env.dispose();
  });

  it('normalizes a replayed active goal to paused on mount', async () => {
    const env = await startGoalTest({
      seed: async (harness) => {
        const writer = featureWriterOf(harnessInternals(harness.app), 'sess');
        const log = await writer.open<GoalEvent>('agents/main/goal');
        await log.commit({ events: [{ type: GOAL_CREATE, goalId: 'goal-crash', objective: 'crashed' }] });
      },
    });
    expect(env.goal().getGoal().goal).toMatchObject({
      goalId: 'goal-crash',
      status: 'paused',
      terminalReason: 'Paused after agent resume',
    });

    await env.dispose();
  });

  it('clears a replayed complete goal on mount', async () => {
    const env = await startGoalTest({
      seed: async (harness) => {
        const writer = featureWriterOf(harnessInternals(harness.app), 'sess');
        const log = await writer.open<GoalEvent>('agents/main/goal');
        await log.commit({
          events: [
            { type: GOAL_CREATE, goalId: 'goal-done', objective: 'finished' },
            { type: GOAL_UPDATE, status: 'complete', reason: 'wrapped' },
          ],
        });
      },
    });
    expect(env.goal().getGoal().goal).toBeNull();

    await env.dispose();
  });

  it('drives the goal tools through model turns with goal-start approval', async () => {
    const env = await startGoalTest();
    const interactions = env.interactions();
    const captured: Interaction[] = [];
    let response: GoalStartApprovalResponse = { decision: 'approved' };
    env.harness.app.on(interaction, 'interaction.requested', (event) => {
      captured.push(event.interaction);
      interactions.respond(event.interaction.id, response);
    });
    const lastResult = async (): Promise<string> => toolResultTexts(await env.messages()).at(-1) ?? '';
    const quiesce = async (): Promise<void> => {
      await env.goal().cancelGoal().catch(() => {});
      await env.settle();
      await env.main().flush();
    };

    queue = [
      {
        toolCall: {
          name: 'CreateGoal',
          arguments: JSON.stringify({ objective: 'tool created', completionCriterion: 'tests pass' }),
        },
      },
      { text: 'created' },
    ];
    await env.runTurn();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('approval');
    expect(captured[0]?.payload).toMatchObject({
      kind: 'goal_start',
      objective: 'tool created',
      completionCriterion: 'tests pass',
    });
    const createdOut = JSON.parse(await lastResult()) as { goal: Record<string, unknown> | null };
    expect(createdOut.goal).toMatchObject({
      objective: 'tool created',
      completionCriterion: 'tests pass',
      status: 'active',
    });
    expect(createdOut.goal?.['goalId']).toBeUndefined();
    await quiesce();

    queue = [
      { toolCall: { name: 'CreateGoal', arguments: JSON.stringify({ objective: 'rejected goal' }) } },
      { text: 'after rejection' },
    ];
    response = { decision: 'rejected', feedback: 'not now' };
    await env.runTurn();
    expect(await lastResult()).toBe(
      'Tool "CreateGoal" was not run because the user rejected the approval request. Reason: not now',
    );
    expect(env.goal().getGoal().goal).toBeNull();
    response = { decision: 'approved' };

    queue = [{ toolCall: { name: 'GetGoal', arguments: '{}' } }, { text: 'read' }];
    await env.runTurn();
    expect(JSON.parse(await lastResult())).toEqual({ goal: null });

    queue = [updateGoalCall('paused'), { text: 'after invalid' }];
    await env.runTurn();
    expect(await lastResult()).toBe('Invalid goal status. Use `active`, `complete`, or `blocked`.');
    expect(toolResultIsErrors(await env.messages()).at(-1)).toBe(true);

    queue = [updateGoalCall('complete'), { text: 'after missing' }];
    await env.runTurn();
    expect(await lastResult()).toBe('Goal not completed: no active goal.');
    expect(toolResultIsErrors(await env.messages()).at(-1)).toBe(false);

    queue = [
      { toolCall: { name: 'SetGoalBudget', arguments: JSON.stringify({ value: 5, unit: 'turns' }) } },
      { text: 'after budget' },
    ];
    await env.runTurn();
    expect(await lastResult()).toBe('Goal budget not set: no current goal.');

    queue = [
      { toolCall: { name: 'CreateGoal', arguments: JSON.stringify({ objective: 'budget target' }) } },
      { text: 'created' },
    ];
    await env.runTurn();
    queue = [
      { toolCall: { name: 'SetGoalBudget', arguments: JSON.stringify({ value: 30, unit: 'minutes' }) } },
      { text: 'budget set' },
    ];
    await env.runTurn();
    expect(await lastResult()).toBe('Goal budget set: 30 minutes.');
    expect(env.goal().getGoal().goal?.budget.wallClockBudgetMs).toBe(1_800_000);

    queue = [
      { toolCall: { name: 'SetGoalBudget', arguments: JSON.stringify({ value: 500, unit: 'milliseconds' }) } },
      { text: 'budget tiny' },
    ];
    await env.runTurn();
    expect(await lastResult()).toBe('Goal budget not set: 500 milliseconds is not a reasonable goal budget.');

    queue = [
      { toolCall: { name: 'SetGoalBudget', arguments: JSON.stringify({ value: 1.4, unit: 'turns' }) } },
      { text: 'budget rounded' },
    ];
    await env.runTurn();
    await env.settle();
    expect(await lastResult()).toBe(
      'Goal budget set: 1 turn. The goal has already reached this budget and will stop now.',
    );
    expect(env.goal().getGoal().goal).toMatchObject({
      status: 'blocked',
      terminalReason: 'Blocked after goal budget reached: turn budget 1',
    });
    await quiesce();

    queue = [updateGoalCall('complete'), { text: 'summary' }];
    await env.runTurn();
    expect(await lastResult()).toBe('Goal not completed: no active goal.');

    await env.dispose();
  });

  it('restricts goal tools to the main agent', async () => {
    const env = await startGoalTest();
    const sub = await env.harness.ensureAgent(
      env.harness.app.sessions.get('sess')!,
      'sub-1',
      { systemPrompt: 'sub-host' },
    );
    setRequester(env.harness, 'sess', 'sub-1', createMockRequester());

    for (const [name, args] of [
      ['CreateGoal', JSON.stringify({ objective: 'sub goal' })],
      ['GetGoal', '{}'],
      ['UpdateGoal', JSON.stringify({ status: 'complete' })],
      ['SetGoalBudget', JSON.stringify({ value: 5, unit: 'turns' })],
    ] as const) {
      queue = [{ toolCall: { name, arguments: args } }, { text: 'done' }];
      const done = new Promise<void>((resolve) => {
        const unsubscribe = sub.loop.subscribe((event) => {
          if (event.type !== 'turn.ended') return;
          unsubscribe();
          resolve();
        });
      });
      sub.loop.submit(user('go'));
      await done;
      await sub.flush();
      const subMessages = sub.view.getState().messages;
      expect(toolResultTexts(subMessages).at(-1)).toBe(
        'Goal tools are only supported by the main agent.',
      );
      expect(toolResultIsErrors(subMessages).at(-1)).toBe(true);
    }
    expect(env.goal().getGoal().goal).toBeNull();

    await env.dispose();
  });

  it('pauses the goal after a failed turn', async () => {
    const failingRequester: LoopLlmRequester = {
      with: () => failingRequester,
      request: (part) => part as unknown as LlmRequest,
      generate: async () => {
        throw new Error('boom');
      },
    };
    const env = await startGoalTest({ requester: failingRequester });
    const goal = env.goal();
    await goal.createGoal({ objective: 'will fail' });

    await env.runTurn();
    await env.settle();

    expect(goal.getGoal().goal).toMatchObject({
      status: 'paused',
      terminalReason: 'Paused after runtime error: boom',
    });

    await env.dispose();
  });

  it('re-prompts with the step-cap continuation prompt after a max-steps turn', async () => {
    const env = await startGoalTest({ maxSteps: 1 });
    const interactions = env.interactions();
    env.harness.app.on(interaction, 'interaction.requested', (event) => {
      interactions.respond(event.interaction.id, { decision: 'approved' });
    });
    const goal = env.goal();

    queue = [
      { toolCall: { name: 'CreateGoal', arguments: JSON.stringify({ objective: 'long work' }) } },
      readCall(),
      { text: 'wrapped' },
    ];
    env.main().loop.submit(user('go'));
    await env.waitForTurns(2);
    await goal.cancelGoal().catch(() => {});
    await env.settle();

    expect(env.turnDones[0]?.outcome).toMatchObject({
      type: 'blocked',
      cause: { reason: 'max_steps' },
    });
    const continuations = (await env.messages()).filter((entry) =>
      isGoalContinuationOrigin(entry.meta?.origin),
    );
    expect(continuations.length).toBeGreaterThanOrEqual(1);
    expect(extractText(continuations[0]!.message)).toContain(
      'The previous goal turn reached the per-turn step limit before finishing its work,',
    );

    await env.dispose();
  });

  it('injects one goal reminder per turn with the active, paused, blocked, and cancelled variants', async () => {
    const env = await startGoalTest();
    const goal = env.goal();
    await goal.createGoal({ objective: 'remind <me> & all', completionCriterion: 'done <well>' });
    await goal.setBudgetLimits({ budgetLimits: { turnBudget: 10 } });

    queue = [readCall(), readCall(), updateGoalCall('blocked'), { text: 'final' }];
    await env.runTurn();
    await env.waitForTurns(2);

    let messages = await env.messages();
    let reminders = goalReminders(messages, GOAL_REMIND_KEY);
    expect(reminders).toHaveLength(1);
    const active = reminderBody(reminders[0]!);
    expect(active).toContain('<untrusted_objective>\nremind &lt;me&gt; &amp; all\n</untrusted_objective>');
    expect(active).toContain(
      '<untrusted_completion_criterion>\ndone &lt;well&gt;\n</untrusted_completion_criterion>',
    );
    expect(active).toContain('Status: active');
    expect(active).toContain('Budgets: turns 0/10 (remaining 10)');

    await goal.resumeGoal();
    await goal.markBlocked({ reason: 'need creds' });
    queue = [readCall(), { text: 'next' }];
    await env.runTurn();
    await env.settle();
    messages = await env.messages();
    reminders = goalReminders(messages, GOAL_REMIND_KEY);
    expect(reminders).toHaveLength(3);
    expect(reminderBody(reminders[2]!)).toContain('There is a goal, currently blocked (need creds).');

    await goal.resumeGoal();
    await goal.pauseGoal({ reason: 'break' });
    queue = [readCall(), { text: 'next' }];
    await env.runTurn();
    await env.settle();
    messages = await env.messages();
    reminders = goalReminders(messages, GOAL_REMIND_KEY);
    expect(reminders).toHaveLength(4);
    expect(reminderBody(reminders[3]!)).toContain('There is a goal, currently paused (break).');

    await env.remount();
    queue = [readCall(), { text: 'next' }];
    await env.runTurn();
    await env.settle();
    messages = await env.messages();
    reminders = goalReminders(messages, GOAL_REMIND_KEY);
    expect(reminders).toHaveLength(5);
    expect(reminderBody(reminders[4]!)).toContain('There is a goal, currently paused (break).');

    await env.goal().cancelGoal();
    queue = [readCall(), { text: 'after cancel' }];
    await env.runTurn();
    await env.settle();
    messages = await env.messages();
    const cancelled = goalReminders(messages, GOAL_CANCELLED_REMINDER_NAME);
    expect(cancelled).toHaveLength(1);
    expect(reminderBody(cancelled[0]!)).toContain('The user cancelled the current goal.');

    await env.dispose();
  });
});
