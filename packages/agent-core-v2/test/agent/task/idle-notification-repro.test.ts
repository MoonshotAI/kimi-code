/**
 * Repro for bug: "after a group of background agents complete, the
 * main agent doesn't receive notifications".
 *
 * Unlike `background-manager.test.ts` (which mocks `agent.turn.steer`),
 * this file drives a real `Agent` instance so we can verify the
 * full chain:
 *
 *    task terminal → notifyAgentTask → loop.enqueue(TaskNotificationStepRequest)
 *      → (busy) the mergeable request folds into the active turn's next step
 *      → (idle / race) `activeOrNewTurn` admission launches a fresh turn for
 *        the notification — matching v1's `turn.steer`, the model consumes it
 *        without waiting for the user
 *
 * Delivery is queue-ordered and the message only materializes when the loop
 * pops the request. If a scenario fails to inject the notification into an
 * LLM call, the per-notification `waitFor` times out, making the failure
 * mode explicit.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/session/agentLifecycle/tools/subagent-task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from './stubs';

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): SubagentTask {
  return new SubagentTask(
    { agentId: 'agent-child', profileName: 'coder', completion },
    description,
    new AbortController(),
  );
}

/** `task.notified` fires once per enqueued notification (after the enqueue). */
function notifiedCount(ctx: TestAgentContext): number {
  return ctx.allEvents.filter((e) => e.event === 'task.notified').length;
}

describe('task notification → main agent (real Agent instance)', () => {
  describe('live notification delivery', () => {
    let ctx: TestAgentContext;
    let background: IAgentTaskService;
    let loop: IAgentLoopService;
    let profile: IAgentProfileService;

    beforeEach(() => {
      ctx = createTestAgent();
      background = ctx.get(IAgentTaskService);
      loop = ctx.get(IAgentLoopService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: [] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('IDLE: completed bg agent notification auto-launches a turn that consumes it', async () => {
      expect(loop.status().activeTurnId).toBeUndefined();
      expect(ctx.llmCalls.length).toBe(0);

      // `activeOrNewTurn` admission: with no active turn the notification
      // launches a fresh turn on its own — no user prompt needed.
      ctx.mockNextResponse({ type: 'text', text: 'ack from main agent' });
      const turnEnd = ctx.untilTurnEnd();
      const taskId = background.registerTask(agentTask(
        Promise.resolve({ result: 'background agent finished its job' }),
        'idle-state repro',
      ));
      await background.wait(taskId);

      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(1);
        },
        { timeout: 2000 },
      );
      await turnEnd;

      expect(ctx.llmCalls.length).toBe(1);
      const lastCall = ctx.llmCalls.at(-1)!;
      const flatHistoryText = JSON.stringify(lastCall.history);
      expect(flatHistoryText).toContain('<notification');
      expect(flatHistoryText).toContain('task.completed');
      expect(flatHistoryText).toContain(taskId);
      expect(flatHistoryText).toContain('idle-state repro completed.');
      expect(flatHistoryText).toContain('<output-file');
      expect(flatHistoryText).not.toContain('background agent finished its job');
    });

    it('BUSY: completed bg agent during an active turn is flushed into an LLM call', async () => {
      // The notification is enqueued (mergeable, agent-scoped) while the
      // user-prompted turn runs. Depending on delivery timing it either
      // folds into that turn's next step or launches its own follow-up turn
      // once the first one ends — in every case it must reach an LLM call.
      // Three scripted responses cover both branches plus the drain prompt.
      ctx.mockNextResponse({ type: 'text', text: 'first turn ack' });
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      ctx.mockNextResponse({ type: 'text', text: 'drain turn ack' });

      const promptPromise = ctx.rpc.prompt({
        input: [{ type: 'text', text: 'kick off a turn' }],
      });

      // Right after kicking off, register a background task that completes
      // immediately, so the notification is enqueued mid-turn.
      const taskId = background.registerTask(agentTask(
        Promise.resolve({ result: 'busy-state bg result' }),
        'busy-state repro',
      ));

      await promptPromise;
      await ctx.untilTurnEnd();
      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(1);
        },
        { timeout: 2000 },
      );

      // Drain whatever the first turn left queued, then assert the
      // notification reached an LLM call whichever branch delivered it.
      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'drain the queue' }],
      });
      await ctx.untilTurnEnd();

      const delivered = ctx.llmCalls.some((call) => {
        const flat = JSON.stringify(call.history);
        return flat.includes('<notification') && flat.includes(taskId);
      });
      expect(delivered).toBe(true);

      // …and it must be materialized in the agent's context history.
      const data = ctx.contextData();
      const flatContext = JSON.stringify(data);
      expect(flatContext).toContain('<notification');
      expect(flatContext).toContain('task.completed');
      expect(flatContext).toContain(taskId);
      expect(flatContext).toContain('busy-state repro completed.');
      expect(flatContext).toContain('<output-file');
      expect(flatContext).not.toContain('busy-state bg result');
    });

    it('IDLE × N: a GROUP of bg agents completes — the first notification launches one turn, the rest fold in', async () => {
      // The first idle delivery launches a turn; later notifications fold
      // into it as mergeable requests (or launch a follow-up if they land
      // after it ends). Three scripted responses cover the worst case of
      // one LLM call per notification.
      ctx.mockNextResponse({ type: 'text', text: 'ack group 1' });
      ctx.mockNextResponse({ type: 'text', text: 'ack group 2' });
      ctx.mockNextResponse({ type: 'text', text: 'ack group 3' });
      const turnEnd = ctx.untilTurnEnd();
      const taskIds = [
        background.registerTask(agentTask(
          Promise.resolve({ result: 'bg #1 result' }),
          'group-1',
        )),
        background.registerTask(agentTask(
          Promise.resolve({ result: 'bg #2 result' }),
          'group-2',
        )),
        background.registerTask(agentTask(
          Promise.resolve({ result: 'bg #3 result' }),
          'group-3',
        )),
      ];

      for (const id of taskIds) {
        await background.wait(id);
      }

      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(3);
        },
        { timeout: 2000 },
      );
      await turnEnd;
      await vi.waitFor(
        () => {
          expect(loop.status().state).toBe('idle');
          expect(loop.status().hasPendingRequests).toBe(false);
        },
        { timeout: 2000 },
      );

      // Every notification reached an LLM call — either merged into the
      // auto-launched turn's first batch or carried by a follow-up step.
      const flatHistoryText = JSON.stringify(ctx.llmCalls.map((call) => call.history));
      for (const id of taskIds) {
        expect(flatHistoryText).toContain(id);
      }
      expect(flatHistoryText).toContain('group-1 completed.');
      expect(flatHistoryText).toContain('group-2 completed.');
      expect(flatHistoryText).toContain('group-3 completed.');
      expect(flatHistoryText).toContain('<output-file');
      expect(flatHistoryText).not.toContain('bg #1 result');
      expect(flatHistoryText).not.toContain('bg #2 result');
      expect(flatHistoryText).not.toContain('bg #3 result');
    });

    it('RACE: bg completion right after turn end launches its own turn', async () => {
      // 1st turn: prompted by user — produces text and ends.
      ctx.mockNextResponse({ type: 'text', text: 'first user-prompted ack' });
      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'hello main agent' }],
      });
      await ctx.untilTurnEnd();
      expect(ctx.llmCalls.length).toBe(1);

      // Fire the bg completion while the agent is idle: `activeOrNewTurn`
      // admission launches a fresh turn for the notification.
      ctx.mockNextResponse({ type: 'text', text: 'ack from bg notification' });
      const turnEnd = ctx.untilTurnEnd();
      const taskId = background.registerTask(agentTask(
        Promise.resolve({ result: 'post-turn bg result' }),
        'race-after-turn',
      ));
      await background.wait(taskId);
      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(1);
        },
        { timeout: 2000 },
      );
      await turnEnd;

      expect(ctx.llmCalls.length).toBe(2);
      const lastCall = ctx.llmCalls.at(-1)!;
      const flatHistoryText = JSON.stringify(lastCall.history);
      expect(flatHistoryText).toContain('<notification');
      expect(flatHistoryText).toContain(taskId);
      expect(flatHistoryText).toContain('race-after-turn completed.');
      expect(flatHistoryText).toContain('<output-file');
      expect(flatHistoryText).not.toContain('post-turn bg result');
    });
  });

  describe('resumed notifications', () => {
    let sessionDir: string;
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;
    let loop: IAgentLoopService;

    beforeEach(async () => {
      sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-repro-'));
      // Simulate a previous session's bash bg task that completed
      // before exit and an agent bg task that didn't (will be lost).
      const backgroundPersistence = createAgentTaskPersistence(sessionDir);
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

      ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
      background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
      loop = ctx.get(IAgentLoopService);
      const profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: [] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        await rm(sessionDir, { recursive: true, force: true });
      }
    });

    it('RESUME: terminal bg tasks discovered on reconcile are SILENTLY injected (no auto-turn)', async () => {
      // Scenario the user described: kimi exits while bg tasks are
      // running; on next start, resume() loads them from disk and
      // reconcile() classifies them as terminal (lost for in-process
      // agent tasks; possibly completed for bash tasks if the process
      // wrote a terminal state). The restore path appends the
      // notifications to context directly, NOT via the loop queue, so:
      //   - Notification XML lands in context history ✓
      //   - No new turn is launched ✗
      //   - User sees nothing happen until they type
      //
      // This test pins that current behavior so any change shows up.

      // We do NOT mock any LLM response. If the resume path
      // mistakenly launches a turn, scripted-generate throws
      // "Unexpected generate call" and the test fails loudly.
      const launchSpy = vi.spyOn(loop as unknown as { startTurn: () => unknown }, 'startTurn');

      // Reproduce Agent.resume()'s post-replay sequence.
      await background.loadFromDisk();
      await background.reconcile();

      // The agent-* running task should now be lost.
      expect(background.getTask('agent-prev0000')?.status).toBe('lost');

      // Give the silent append a beat.
      await vi.waitFor(() => {
        const flatContext = JSON.stringify(ctx.contextData());
        expect(flatContext).toContain('bash-prev0000');
        expect(flatContext).toContain('agent-prev0000');
      });

      // Hard assertion: no turn was launched for either restored task.
      // The notifications were silently appended (never enqueued onto the
      // loop), so no new turn ran.
      expect(launchSpy).not.toHaveBeenCalled();
      expect(ctx.llmCalls.length).toBe(0);
      expect(loop.status().activeTurnId).toBeUndefined();

      // Both notifications are in context, waiting for the user. The
      // completed bash task references its persisted output file rather
      // than inlining the content (parity with the restored-notification
      // behavior pinned in background/rpc-events.test.ts).
      const flatContext = JSON.stringify(ctx.contextData());
      expect(flatContext).toContain('<output-file');
      expect(flatContext).not.toContain('previous bash output');
      expect(flatContext).toMatch(/task\.completed/);
      expect(flatContext).toMatch(/task\.lost/);
    });
  });
});
