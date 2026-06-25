/**
 * Repro for bug: "after a group of background agents complete, the
 * main agent doesn't receive notifications".
 *
 * Unlike `background-manager.test.ts` (which mocks `agent.turn.steer`),
 * this file drives a real `Agent` instance so we can verify the
 * full chain:
 *
 *    onLiveTaskTerminal → notifyBackgroundTask → turn.steer()
 *      → (idle) launch() → turnWorker() → LLM generate called with
 *        the notification XML in history
 *      → (busy) buffered into steerBuffer → flushed on next loop step
 *
 * If either scenario fails to inject the notification into the next
 * LLM call, the scripted LLM will throw "Unexpected generate call",
 * making the failure mode explicit.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it, vi } from 'vitest';

import { testAgent } from './harness/agent';
import { BackgroundTaskPersistence } from '../../src/agent/background';
import { agentTask } from './background/helpers';

describe('background notification → main agent (real Agent instance)', () => {
  it('IDLE: completed bg agent auto-starts a new turn with <notification> XML', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: [] });

    expect(ctx.agent.turn.hasActiveTurn).toBe(false);
    expect(ctx.llmCalls.length).toBe(0);

    // The expected auto-launched turn will call generate once, then end.
    ctx.mockNextResponse({ type: 'text', text: 'ack from main agent' });

    const taskId = ctx.agent.background.registerTask(agentTask(
      Promise.resolve({ result: 'background agent finished its job' }),
      'idle-state repro',
    ));

    await ctx.agent.background.wait(taskId);

    // Give the steer→launch→turnWorker→generate chain time to run.
    await vi.waitFor(
      () => {
        expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    // The latest LLM call must include the notification XML the
    // BackgroundManager injected via `turn.steer`.
    const lastCall = ctx.llmCalls.at(-1)!;
    const flatHistoryText = JSON.stringify(lastCall.history);
    expect(flatHistoryText).toContain('<notification');
    expect(flatHistoryText).toContain('task.completed');
    expect(flatHistoryText).toContain(taskId);
    expect(flatHistoryText).toContain('idle-state repro completed');
    expect(flatHistoryText).toContain('background agent finished its job');
    expect(flatHistoryText).toContain('<output-preview');
  });

  it('BUSY: completed bg agent during an active turn is flushed before the next LLM call', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: [] });

    // Step 1 of the user-prompted turn: produce no tool call, end turn.
    // But to give the steerBuffer a chance to be flushed we want a
    // multi-step turn. So instead: queue a text response for step 1
    // that DOESN'T end the turn yet (set finishReason to tool_calls
    // is wrong because we have no tool call). Easiest is to chain two
    // responses: first one is text-only (so step ends), the steer
    // notification arrives during that step, then a second LLM call
    // happens that should contain the notification.
    //
    // Actually with the scripted-generate harness, a text-only
    // response yields finishReason='completed' and the turn ends.
    // To force a 2-step turn we need the first step to emit a tool
    // call. Since we configured no tools, we can't. So this BUSY
    // case is hard to model without LLM-side multi-step. Instead we
    // test the buffer mechanism directly:

    const steerSpy = vi.spyOn(ctx.agent.turn, 'steer');

    // Pretend a turn is active by calling prompt and not awaiting end.
    // Queue a response that will be consumed.
    ctx.mockNextResponse({ type: 'text', text: 'first turn ack' });
    const promptPromise = ctx.rpc.prompt({
      input: [{ type: 'text', text: 'kick off a turn' }],
    });

    // Right after kicking off, register a background task that
    // completes immediately. The notification should be steer()d
    // while activeTurn is still set, landing in the steerBuffer.
    const taskId = ctx.agent.background.registerTask(agentTask(
      Promise.resolve({ result: 'busy-state bg result' }),
      'busy-state repro',
    ));

    // Wait for the first turn to end.
    await promptPromise;
    await ctx.untilTurnEnd();

    // steer() must have been called at least once for our task.
    await vi.waitFor(() => {
      expect(steerSpy).toHaveBeenCalled();
    });
    const matchingCall = steerSpy.mock.calls.find((c) => {
      const origin = c[1] as { kind?: string; taskId?: string } | undefined;
      return origin?.kind === 'background_task' && origin.taskId === taskId;
    });
    expect(matchingCall).toBeDefined();

    // After the turn ends, the steerBuffer should be flushed —
    // i.e. the notification text appears as a user message in
    // the agent's context history.
    const data = ctx.agent.context.data();
    const flatContext = JSON.stringify(data);
    expect(flatContext).toContain('<notification');
    expect(flatContext).toContain('task.completed');
    expect(flatContext).toContain(taskId);
    expect(flatContext).toContain('busy-state repro completed');
    expect(flatContext).toContain('busy-state bg result');
    expect(flatContext).toContain('<output-preview');
  });

  it('IDLE × N: a GROUP of bg agents completes — all notifications should reach the LLM', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: [] });

    // Only one auto-launched turn is expected; its beforeStep should
    // drain ALL buffered notifications. So one queued response is enough.
    ctx.mockNextResponse({ type: 'text', text: 'ack group' });

    const taskIds = [
      ctx.agent.background.registerTask(agentTask(
        Promise.resolve({ result: 'bg #1 result' }),
        'group-1',
      )),
      ctx.agent.background.registerTask(agentTask(
        Promise.resolve({ result: 'bg #2 result' }),
        'group-2',
      )),
      ctx.agent.background.registerTask(agentTask(
        Promise.resolve({ result: 'bg #3 result' }),
        'group-3',
      )),
    ];

    for (const id of taskIds) {
      await ctx.agent.background.wait(id);
    }

    await vi.waitFor(
      () => {
        expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    const lastCall = ctx.llmCalls.at(-1)!;
    const flatHistoryText = JSON.stringify(lastCall.history);

    // ⚠️ Each of the 3 tasks' notifications must show up in the LLM
    // history of the (single) auto-launched turn.
    for (const id of taskIds) {
      expect(flatHistoryText).toContain(id);
    }
    expect(flatHistoryText).toContain('group-1 completed');
    expect(flatHistoryText).toContain('group-2 completed');
    expect(flatHistoryText).toContain('group-3 completed');
    expect(flatHistoryText).toContain('bg #1 result');
    expect(flatHistoryText).toContain('bg #2 result');
    expect(flatHistoryText).toContain('bg #3 result');
    expect(flatHistoryText).toContain('<output-preview');
  });

  it('RACE: bg completion fires AFTER LLM returns but BEFORE activeTurn is cleared', async () => {
    // We're hunting a window: shouldContinueAfterStop reads an empty
    // steerBuffer → returns { continue: false } → runTurn unwinds →
    // finally block hasn't yet set activeTurn = null. If a steer()
    // lands in this window, it gets buffered, then activeTurn=null
    // and the buffer is never flushed until the next user prompt.
    const ctx = testAgent();
    ctx.configure({ tools: [] });

    // 1st turn: prompted by user — produces text and ends.
    ctx.mockNextResponse({ type: 'text', text: 'first user-prompted ack' });

    // Schedule the bg completion to fire when the first turn ends.
    // The cleanest trigger: hook into the `turn.ended` event.
    let onTurnEnded: () => void = () => {};
    const turnEndedPromise = new Promise<void>((resolve) => {
      onTurnEnded = resolve;
    });
    ctx.emitter.on('turn.ended', () => {
      onTurnEnded();
    });

    // Kick off the user-prompted turn — don't await yet.
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'hello main agent' }],
    });

    // Wait until turn.ended fires.
    await ctx.untilTurnEnd();
    await turnEndedPromise;

    // At this point activeTurn should be null. Now fire the bg
    // completion — this is the IDLE path, NOT the racy one. We
    // queue an LLM response so the auto-launched turn can run.
    ctx.mockNextResponse({ type: 'text', text: 'auto ack from bg notification' });
    const taskId = ctx.agent.background.registerTask(agentTask(
      Promise.resolve({ result: 'post-turn bg result' }),
      'race-after-turn',
    ));

    await ctx.agent.background.wait(taskId);

    // The notification arriving while idle should auto-launch a turn.
    await vi.waitFor(
      () => {
        expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2000 },
    );

    const lastCall = ctx.llmCalls.at(-1)!;
    const flatHistoryText = JSON.stringify(lastCall.history);
    expect(flatHistoryText).toContain('<notification');
    expect(flatHistoryText).toContain(taskId);
    expect(flatHistoryText).toContain('race-after-turn completed');
    expect(flatHistoryText).toContain('post-turn bg result');
    expect(flatHistoryText).toContain('<output-preview');
  });

  it('RESUME: terminal bg tasks discovered on reconcile are SILENTLY injected (no auto-turn)', async () => {
    // Scenario the user described: kimi exits while bg tasks are
    // running; on next start, resume() loads them from disk and
    // reconcile() classifies them as terminal (lost for in-process
    // agent tasks; possibly completed for bash tasks if the process
    // wrote a terminal state). The restore path uses
    // `appendUserMessage`, NOT `steer`, so:
    //   - Notification XML lands in context history ✓
    //   - No new turn is launched ✗
    //   - User sees nothing happen until they type
    //
    // This test pins that current behavior so any change shows up.

    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-repro-'));
    try {
      // Simulate a previous session's bash bg task that completed
      // before exit and an agent bg task that didn't (will be lost).
      const backgroundPersistence = new BackgroundTaskPersistence(sessionDir);
      await backgroundPersistence.writeTask({
        taskId: 'bash-prev0000',
        kind: 'process',
        command: 'echo previous',
        description: 'previous bash task',
        pid: 12345,
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_005,
        exitCode: 0,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput('bash-prev0000', 'previous bash output');

      await backgroundPersistence.writeTask({
        taskId: 'agent-prev0000',
        kind: 'agent',
        description: 'previous agent task',
        startedAt: 1_700_000_000,
        endedAt: null,
        status: 'running',
      });

      const ctx = testAgent({ homedir: sessionDir });
      ctx.configure({ tools: [] });

      // We do NOT mock any LLM response. If the resume path
      // mistakenly launches a turn, scripted-generate throws
      // "Unexpected generate call" and the test fails loudly.
      const steerSpy = vi.spyOn(ctx.agent.turn, 'steer');

      // Reproduce Agent.resume()'s post-replay sequence.
      await ctx.agent.background.loadFromDisk();
      await ctx.agent.background.reconcile();

      // The agent-* running task should now be lost.
      expect(ctx.agent.background.getTask('agent-prev0000')?.status).toBe('lost');

      // Give the silent append a beat.
      await vi.waitFor(() => {
        const flatContext = JSON.stringify(ctx.agent.context.data());
        expect(flatContext).toContain('bash-prev0000');
        expect(flatContext).toContain('agent-prev0000');
      });

      // Hard assertion: steer was NOT called for either restored task.
      // The notifications were silently appended, so no new turn ran.
      expect(steerSpy).not.toHaveBeenCalled();
      expect(ctx.llmCalls.length).toBe(0);
      expect(ctx.agent.turn.hasActiveTurn).toBe(false);

      // Both notifications are in context, waiting for the user.
      const flatContext = JSON.stringify(ctx.agent.context.data());
      expect(flatContext).toContain('<output-file');
      expect(flatContext).toContain(backgroundPersistence.taskOutputFile('bash-prev0000'));
      expect(flatContext).not.toContain('previous bash output');
      expect(flatContext).toMatch(/task\.completed/);
      expect(flatContext).toMatch(/task\.lost/);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});
