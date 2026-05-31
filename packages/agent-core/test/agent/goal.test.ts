import type { ToolCall } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testAgent } from './harness/agent';

const goalFlag = 'KIMI_CODE_EXPERIMENTAL_GOAL_MODE';
let previousGoalFlag: string | undefined;

beforeEach(() => {
  previousGoalFlag = process.env[goalFlag];
  process.env[goalFlag] = '1';
});

afterEach(() => {
  vi.useRealTimers();
  if (previousGoalFlag === undefined) delete process.env[goalFlag];
  else process.env[goalFlag] = previousGoalFlag;
});

describe('Agent goal mode', () => {
  it('persists goal lifecycle state across resume', async () => {
    const ctx = testAgent();

    ctx.agent.goal.set('Finish the migration with green tests', 1_000);
    ctx.agent.goal.pause();

    expect(ctx.agent.goal.data()).toMatchObject({
      objective: 'Finish the migration with green tests',
      status: 'paused',
      tokenBudget: 1_000,
      tokensUsed: 0,
      remainingTokens: 1_000,
    });
    await ctx.expectResumeMatches();

    ctx.agent.goal.clear();
    expect(ctx.agent.goal.data()).toBeNull();
    await ctx.expectResumeMatches();
  });

  it('continues after a model stop until update_goal completes the goal', async () => {
    const updateGoalCall: ToolCall = {
      type: 'function',
      id: 'call_update_goal',
      name: 'update_goal',
      arguments: '{"status":"complete"}',
    };
    const ctx = testAgent();
    ctx.configure({ tools: ['update_goal'] });
    ctx.agent.goal.set('Finish the focused task');

    ctx.mockNextResponse({ type: 'text', text: 'I need one more pass.' });
    ctx.mockNextResponse({ type: 'text', text: 'The goal is complete.' }, updateGoalCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the task' }] });

    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    expect(ctx.llmCalls[1]!.history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Continue working toward the active thread goal'),
          }),
        ],
      }),
    );
    expect(ctx.agent.goal.data()).toMatchObject({ status: 'complete' });
    await ctx.expectResumeMatches();
  });

  it('keeps continuing after model-only goal turns until update_goal completes the goal', async () => {
    const updateGoalCall: ToolCall = {
      type: 'function',
      id: 'call_update_goal',
      name: 'update_goal',
      arguments: '{"status":"complete"}',
    };
    const ctx = testAgent();
    ctx.configure({ tools: ['update_goal'] });
    ctx.agent.goal.set('Finish after multiple continuation turns');

    ctx.mockNextResponse({ type: 'text', text: 'Initial pass needs more work.' });
    ctx.mockNextResponse({ type: 'text', text: 'Still active after the first continuation.' });
    ctx.mockNextResponse({ type: 'text', text: 'Now complete.' }, updateGoalCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the task' }] });

    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);
    expect(ctx.llmCalls[2]!.history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Continue working toward the active thread goal'),
          }),
        ],
      }),
    );
    expect(ctx.agent.goal.data()).toMatchObject({ status: 'complete' });
  });

  it('does not launch goal continuation while restoring records', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'This response should not be consumed.' });

    ctx.agent.records.restore({
      type: 'goal.set',
      objective: 'Do not run during replay',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      usageBaseline: 0,
      activeSince: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    ctx.agent.records.restore({ type: 'plan_mode.exit' });
    await Promise.resolve();

    expect(ctx.llmCalls).toHaveLength(0);
    expect(ctx.agent.goal.data()).toMatchObject({ status: 'active' });
  });

  it('wraps up without starting another goal turn after reaching the token budget', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.goal.set('Finish within the explicit budget', 1);

    ctx.mockNextResponse({ type: 'text', text: 'Initial progress.' });
    ctx.mockNextResponse({ type: 'text', text: 'Wrapping up.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the task' }] });

    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.llmCalls[1]!.history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('has reached its token budget'),
          }),
        ],
      }),
    );
    expect(ctx.agent.goal.data()).toMatchObject({ status: 'budget_limited', remainingTokens: 0 });
  });

  it('counts cached input toward the token budget', () => {
    const ctx = testAgent();
    ctx.agent.goal.set('Track cached input usage', 100);

    ctx.agent.usage.record('cached-model', {
      inputOther: 1,
      inputCacheRead: 95,
      inputCacheCreation: 2,
      output: 3,
    });

    expect(ctx.agent.goal.data()).toMatchObject({
      tokensUsed: 101,
      remainingTokens: 0,
    });
  });

  it('does not reactivate a completed goal through pause or resume', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.goal.set('Keep completed work terminal');
    ctx.agent.goal.complete();

    expect(ctx.agent.goal.pause()).toMatchObject({ status: 'complete' });
    expect(ctx.agent.goal.resume()).toMatchObject({ status: 'complete' });
    ctx.agent.goal.continueAfterResume();

    expect(ctx.agent.goal.data()).toMatchObject({ status: 'complete' });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('does not count offline time as active goal time after restore', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_600_000);
    const ctx = testAgent();

    ctx.agent.goal.restoreSet({
      objective: 'Track active elapsed time only',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      usageBaseline: 0,
      activeSince: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    expect(ctx.agent.goal.data()).toMatchObject({ timeUsedSeconds: 0 });

    vi.advanceTimersByTime(2_000);

    expect(ctx.agent.goal.data()).toMatchObject({ timeUsedSeconds: 2 });
  });

  it('does not auto-continue a restored active goal while the flag is disabled', async () => {
    delete process.env[goalFlag];
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.goal.restoreSet({
      objective: 'Do not continue while experimental goal mode is off',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      usageBaseline: 0,
      activeSince: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    ctx.mockNextResponse({ type: 'text', text: 'Handled the ordinary prompt.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run one ordinary turn' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.agent.goal.data()).toMatchObject({ status: 'active' });
  });

  it('suppresses automatic continuation while plan mode is active', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.goal.set('Resume after plan mode exits');
    await ctx.agent.planMode.enter();

    ctx.mockNextResponse({ type: 'text', text: 'Waiting for plan mode to exit.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'Continuing after plan mode.' });
    ctx.agent.planMode.exit();
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('rejects lifecycle mutations while the experimental flag is disabled', () => {
    delete process.env[goalFlag];
    const ctx = testAgent();

    expect(() => ctx.agent.goal.set('Should stay disabled')).toThrow('Goal mode is disabled');
    expect(ctx.agent.goal.get()).toBeNull();
  });
});
