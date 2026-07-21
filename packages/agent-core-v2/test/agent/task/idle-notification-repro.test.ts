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

import { LifecycleScope, type IAgentScopeHandle } from '#/_base/di/scope';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/session/subagent/tools/subagent-task';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
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
      ctx.mockNextResponse({ type: 'text', text: 'first turn ack' });
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      ctx.mockNextResponse({ type: 'text', text: 'drain turn ack' });

      const promptPromise = ctx.rpc.prompt({
        input: [{ type: 'text', text: 'kick off a turn' }],
      });

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

      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'drain the queue' }],
      });
      await ctx.untilTurnEnd();

      const delivered = ctx.llmCalls.some((call) => {
        const flat = JSON.stringify(call.history);
        return flat.includes('<notification') && flat.includes(taskId);
      });
      expect(delivered).toBe(true);

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
      ctx.mockNextResponse({ type: 'text', text: 'first user-prompted ack' });
      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'hello main agent' }],
      });
      await ctx.untilTurnEnd();
      expect(ctx.llmCalls.length).toBe(1);

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

  describe('kill ordering vs child loop unwind', () => {
    type GenerateFn = typeof kosongGenerate;

    function agentScopeHandle(ctx: TestAgentContext, id: string): IAgentScopeHandle {
      return {
        id,
        kind: LifecycleScope.Agent,
        accessor: { get: ctx.get.bind(ctx) },
        dispose: () => {},
      } as IAgentScopeHandle;
    }

    // Regression for: "manual stop of a background subagent → main
    // auto-resumes → resume fails with 'already running and cannot run
    // concurrently'". The killed task used to settle (and notify) the
    // moment the abort landed — while the child loop was still unwinding,
    // so the resume guard (`ensureOwnedIdleSubagent`, which reads
    // `loop.status().state`) rejected the auto-resume. Settlement must
    // wait for the loop to go idle. A turn that ignores the cancel stays
    // bounded by the task layer's SIGTERM grace instead.
    it('stop settles killed + notifies only after the child loop goes idle', async () => {
      // Child agent whose in-flight LLM call unwinds slowly after cancel
      // (models a tool mid-execution / a slow request abort): it rejects
      // 200ms after the abort lands, not immediately.
      let generateStarted!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        generateStarted = resolve;
      });
      const slowToCancelGenerate: GenerateFn = async (
        _chat,
        _systemPrompt,
        _tools,
        _history,
        _callbacks,
        options,
      ) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        generateStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                reject(signal.reason);
              }, 200);
            },
            { once: true },
          );
        });
        throw new Error('slowToCancelGenerate returned without being aborted');
      };

      const main = createTestAgent(taskServices());
      const child = createTestAgent({ generate: slowToCancelGenerate });
      try {
        const childHandle = agentScopeHandle(child, 'agent-child');
        const childLoop = child.get(IAgentLoopService);

        // Launch the subagent run (what AgentTool.launch does).
        const controller = new AbortController();
        const run = await runAgentTurn(
          childHandle,
          { kind: 'prompt', prompt: 'do background work' },
          { signal: controller.signal },
        );
        // Mirror AgentTool.launch: the task handle maps summary → result.
        const completion = run.completion.then((r) => ({ result: r.summary, usage: r.usage }));
        void completion.catch(() => {});

        // Wait until the in-flight step is genuinely parked inside the LLM
        // call — the loop reports 'running' before the request starts, and
        // stopping that early takes a different (already-fast) path.
        await inFlight;
        expect(childLoop.status().state).toBe('running');

        const background = main.get(IAgentTaskService);
        const taskId = background.registerTask(
          new SubagentTask(
            { agentId: 'agent-child', profileName: 'coder', completion },
            'kill-order repro',
            controller,
          ),
          { detached: true, timeoutMs: 0 },
        );

        // The main agent is idle; the killed notification auto-launches a turn.
        main.mockNextResponse({ type: 'text', text: 'ack from main agent' });
        const notificationTurnEnd = main.untilTurnEnd();

        // Manual stop (TUI / REST path — no notification suppression).
        const info = await background.stop(taskId, 'User initiated stop');
        expect(info?.status).toBe('killed');
        // Settlement waited for the child loop to unwind — this is the
        // assertion the old race-based implementation fails.
        expect(childLoop.status().state).toBe('idle');

        // The task.killed notification reaches the main agent (this is what
        // makes main call Agent(resume="agent-child")), and by then the
        // resume guard's precondition already holds.
        await vi.waitFor(
          () => {
            expect(main.llmCalls.length).toBeGreaterThanOrEqual(1);
          },
          { timeout: 2000 },
        );
        const notified = JSON.stringify(main.llmCalls.at(-1)!.history);
        expect(notified).toContain('task.killed');
        expect(notified).toContain(taskId);
        expect(childLoop.status().state).toBe('idle');

        await notificationTurnEnd;
      } finally {
        await main.dispose();
        await child.dispose();
      }
    });
  });

  describe('resumed notifications', () => {
    let sessionDir: string;
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;
    let loop: IAgentLoopService;

    beforeEach(async () => {
      sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-repro-'));
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

      const launchSpy = vi.spyOn(loop as unknown as { startTurn: () => unknown }, 'startTurn');

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('agent-prev0000')?.status).toBe('lost');

      await vi.waitFor(() => {
        const flatContext = JSON.stringify(ctx.contextData());
        expect(flatContext).toContain('bash-prev0000');
        expect(flatContext).toContain('agent-prev0000');
      });

      expect(launchSpy).not.toHaveBeenCalled();
      expect(ctx.llmCalls.length).toBe(0);
      expect(loop.status().activeTurnId).toBeUndefined();

      const flatContext = JSON.stringify(ctx.contextData());
      expect(flatContext).toContain('<output-file');
      expect(flatContext).not.toContain('previous bash output');
      expect(flatContext).toMatch(/task\.completed/);
      expect(flatContext).toMatch(/task\.lost/);
    });
  });
});
