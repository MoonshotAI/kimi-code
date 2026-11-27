import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { deferred } from '@moonshot-ai/testkit/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnPrompt } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import {
  ISessionSubagentService,
  type AgentRunHandle,
} from '#/session/subagent/subagent';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  restoreTaskHistory,
  startAgentTaskInLoop,
  startControlledTaskInLoop,
} from './stubs';

function notifiedCount(ctx: TestAgentContext): number {
  return ctx.context.history().filter((message) => message.origin?.kind === 'task').length;
}

function mockSubagentRuns(
  ctx: TestAgentContext,
  completions: ReadonlyMap<string, Promise<{ readonly result: string }>>,
): void {
  vi.spyOn(ctx.get(ISessionSubagentService), 'run').mockImplementation(async (agent, request) => {
    const prompt = request.kind === 'prompt' ? request.prompt : '';
    const completion = completions.get(prompt);
    if (completion === undefined) throw new Error(`Unexpected subagent prompt: ${prompt}`);
    return {
      agentId: agent.agentId,
      turn: {} as AgentRunHandle['turn'],
      completion: completion.then(({ result }) => ({ summary: result })),
      partialOutput: () => '',
    };
  });
}

function pendingResult(result: string): { readonly done: Promise<{ readonly result: string }>; finish(): void } {
  let finish = (): void => {};
  const done = new Promise<{ readonly result: string }>((resolve) => {
    finish = () => resolve({ result });
  });
  return { done, finish: () => finish() };
}

function completeTogether(ctx: TestAgentContext, count: number): void {
  const outputs = ctx.get(IAgentTaskOutputService);
  const createCompletion = outputs.createCompletion.bind(outputs);
  const allCompleted = deferred();
  let completed = 0;
  vi.spyOn(outputs, 'createCompletion').mockImplementation(async (...args) => {
    completed += 1;
    if (completed === count) allCompleted.resolve();
    await allCompleted.promise;
    return createCompletion(...args);
  });
}

function startControlledAgent(ctx: TestAgentContext, description: string) {
  return startAgentTaskInLoop(ctx, {
    description,
    prompt: description,
    run_in_background: true,
  });
}

describe('task notification → main agent (real Agent instance)', () => {
  describe('live notification delivery', () => {
    let ctx: TestAgentContext;
    let background: IAgentTaskService;
    let loop: IAgentLoopService;

    beforeEach(() => {
      ctx = createTestAgent();
      background = ctx.get(IAgentTaskService);
      loop = ctx.get(IAgentLoopService);
      loop.update({ activeToolNames: [] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('IDLE: completed bg agent notification auto-launches a turn that consumes it', async () => {
      expect(loop.snapshot().activeTurnId).toBeUndefined();
      expect(ctx.llmCalls.length).toBe(0);
      const run = pendingResult('background agent finished its job');
      mockSubagentRuns(ctx, new Map([['idle-state repro', run.done]]));

      const turnStarted: TurnStarted[] = [];
      const turnPrompts: TurnPrompt[] = [];
      const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
        turnStarted.push(event);
      });
      const promptSubscription = ctx.get(IEventBus).subscribe(TurnPrompt, (event) => {
        turnPrompts.push(event);
      });
      const turnEnd = ctx.untilTurnEnd();
      const { handler } = await startControlledAgent(ctx, 'idle-state repro');
      ctx.mockNextResponse({ type: 'text', text: 'ack from main agent' });
      run.finish();
      const taskId = handler.taskId;
      await handler;
      await background.wait(taskId);

      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1), { timeout: 2000 });
      await turnEnd;
      await loop.settled();

      expect(ctx.llmCalls.length).toBe(3);
      const flatHistoryText = JSON.stringify(ctx.llmCalls.at(-1)!.history);
      expect(flatHistoryText).toContain('<notification');
      expect(flatHistoryText).toContain('task.completed');
      expect(flatHistoryText).toContain(taskId);
      expect(flatHistoryText).toContain('<output-file');
      const notificationTurn = turnStarted.find((event) => event.origin?.kind === 'task');
      expect(notificationTurn?.origin).toMatchObject({ kind: 'task', taskId, status: 'completed' });
      expect(notificationTurn?.prompt).toContain('<notification');
      expect(notificationTurn?.promptId).toEqual(expect.any(String));
      const notificationPromptText = JSON.stringify(
        turnPrompts.find(
          (event) => event.origin.kind === 'task' && event.turnId === notificationTurn?.turnId,
        )?.input,
      );
      expect(notificationPromptText).toContain('<notification');
      expect(notificationPromptText).toContain('<output-file');
      subscription.dispose();
      promptSubscription.dispose();
    });

    it('BUSY: completed bg agent during an active turn is flushed into an LLM call', async () => {
      mockSubagentRuns(ctx, new Map([
        ['busy-state repro', Promise.resolve({ result: 'busy-state bg result' })],
      ]));
      ctx.mockNextResponse({ type: 'text', text: 'first turn ack' });

      const promptPromise = ctx.rpc.prompt({
        input: [{ type: 'text', text: 'kick off a turn' }],
      });
      const { handler } = await startControlledAgent(ctx, 'busy-state repro');
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      ctx.mockNextResponse({ type: 'text', text: 'drain turn ack' });
      const taskId = handler.taskId;
      await handler;

      await promptPromise;
      await ctx.untilTurnEnd();
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1), { timeout: 2000 });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'drain the queue' }] });
      await ctx.untilTurnEnd();
      await loop.settled();

      const delivered = ctx.llmCalls.some((call) => {
        const flat = JSON.stringify(call.history);
        return flat.includes('<notification') && flat.includes(taskId);
      });
      expect(delivered).toBe(true);

      const flatContext = JSON.stringify(ctx.contextData());
      expect(flatContext).toContain('<notification');
      expect(flatContext).toContain('task.completed');
      expect(flatContext).toContain(taskId);
      expect(flatContext).toContain('<output-file');
    });

    it('IDLE × N: a GROUP of bg agents completes — the first notification launches one turn, the rest fold in', async () => {
      const runs = new Map([
        ['group-1', pendingResult('bg #1 result')],
        ['group-2', pendingResult('bg #2 result')],
        ['group-3', pendingResult('bg #3 result')],
      ]);
      mockSubagentRuns(ctx, new Map([...runs].map(([prompt, run]) => [prompt, run.done])));
      completeTogether(ctx, runs.size);
      const handlers = [];
      for (const prompt of runs.keys()) handlers.push(await startControlledAgent(ctx, prompt));
      const turnEnd = ctx.untilTurnEnd();
      ctx.mockNextResponse({ type: 'text', text: 'ack group' });
      for (const run of runs.values()) run.finish();
      const taskIds = handlers.map(({ handler }) => handler.taskId);

      for (const id of taskIds) await background.wait(id);

      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(3), { timeout: 2000 });
      await turnEnd;
      await loop.settled();
      await vi.waitFor(() => {
        expect(loop.snapshot().state).toBe('idle');
        expect(loop.snapshot().hasPendingRequests).toBe(false);
      }, { timeout: 2000 });

      const flatHistoryText = JSON.stringify(ctx.llmCalls.map((call) => call.history));
      for (const id of taskIds) expect(flatHistoryText).toContain(id);
      const notifications = ctx.context.history().filter((message) => message.origin?.kind === 'task');
      expect(notifications).toHaveLength(3);
      expect(JSON.stringify(notifications).match(/<output-file/g)).toHaveLength(3);
      expect(flatHistoryText).toContain('<notification');
    });

    it('RACE: bg completion right after turn end launches its own turn', async () => {
      const run = pendingResult('post-turn bg result');
      mockSubagentRuns(ctx, new Map([['race-after-turn', run.done]]));
      ctx.mockNextResponse({ type: 'text', text: 'first user-prompted ack' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello main agent' }] });
      await ctx.untilTurnEnd();
      expect(ctx.llmCalls.length).toBe(1);

      const turnEnd = ctx.untilTurnEnd();
      const { handler } = await startControlledAgent(ctx, 'race-after-turn');
      ctx.mockNextResponse({ type: 'text', text: 'ack from bg notification' });
      run.finish();
      const taskId = handler.taskId;
      await handler;
      await background.wait(taskId);
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1), { timeout: 2000 });
      await turnEnd;
      await loop.settled();

      expect(ctx.llmCalls.length).toBe(4);
      const flatHistoryText = JSON.stringify(ctx.llmCalls.at(-1)!.history);
      expect(flatHistoryText).toContain('<notification');
      expect(flatHistoryText).toContain(taskId);
      expect(flatHistoryText).toContain('<output-file');
    });
  });

  describe('kill ordering vs child loop unwind', () => {
    function agentScopeHandle(ctx: TestAgentContext, id: string): IAgentScopeHandle {
      return {
        id,
        kind: LifecycleScope.Agent,
        accessor: { get: ctx.get.bind(ctx) },
        dispose: () => {},
      } as IAgentScopeHandle;
    }

    it('stops child tasks without notifying the child after the parent is killed', async () => {
      const main = createTestAgent(taskServices());
      const child = createTestAgent();
      try {
        const childTask = await startControlledTaskInLoop(child, { description: 'child detached work' });
        const childTaskId = childTask.handler.taskId;
        child.mockNextResponse({ type: 'text', text: 'child final response' });

        const childHandle = agentScopeHandle(child, 'agent-child');
        const childLoop = child.get(IAgentLoopService);
        const childTasks = child.get(IAgentTaskService);
        const lifecycle = main.get(IAgentLifecycleService);
        const originalHandleOf = lifecycle.handleOf.bind(lifecycle);
        vi.spyOn(lifecycle, 'handleOf').mockImplementation((agentId) =>
          agentId === 'agent-child' ? childHandle : originalHandleOf(agentId)
        );
        vi.spyOn(main.get(ISessionSubagentService), 'spawn').mockImplementation(async (options) => ({
          agentId: 'agent-child',
          profileName: options.plan.profileName ?? 'coder',
          model: options.plan.model,
          promptText: options.prompt,
        }));
        vi.spyOn(main.get(ISessionSubagentService), 'run').mockImplementation(async (_agent, _request, options) =>
          runAgentTurn(
            childHandle,
            { kind: 'prompt', prompt: 'do background work' },
            { signal: options.signal },
          )
        );

        const notificationTurnEnd = main.untilTurnEnd();
        const { handler } = await startControlledAgent(main, 'kill-order repro');
        main.mockNextResponse({ type: 'text', text: 'ack from main agent' });
        const taskId = handler.taskId;
        await handler;
        await vi.waitFor(() => {
          expect(child.llmCalls).toHaveLength(3);
        });
        expect(childLoop.snapshot().state).toBe('idle');
        expect(childTasks.list(true).map((info) => info.taskId)).toEqual([childTaskId]);

        const background = main.get(IAgentTaskService);
        const info = await background.stop(taskId, 'User initiated stop');
        expect(info?.status).toBe('killed');
        expect(childLoop.snapshot().state).toBe('idle');
        expect(childTasks.getTask(childTaskId)?.status).toBe('killed');
        expect(childTasks.list(true)).toEqual([]);
        expect(child.context.history().filter((message) => message.origin?.kind === 'task')).toEqual([]);
        expect(child.llmCalls).toHaveLength(3);

        await vi.waitFor(() => {
          expect(main.llmCalls.length).toBeGreaterThanOrEqual(1);
        }, { timeout: 2000 });
        await notificationTurnEnd;
        await main.get(IAgentLoopService).settled();
        const notified = JSON.stringify(main.llmCalls.at(-1)!.history);
        expect(notified).toContain(taskId);
        expect(notified).toMatch(/task\.killed/);
        expect(childLoop.snapshot().state).toBe('idle');
      } finally {
        await main.dispose();
        await child.dispose();
      }
    });
  });

  describe('resumed notifications', () => {
    let sessionDir: string;
    let ctx: TestAgentContext;
    let background: IAgentTaskService;
    let loop: IAgentLoopService;
    let previousTasks: AgentTaskInfo[];

    beforeEach(async () => {
      sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-repro-'));
      const backgroundPersistence = createAgentTaskPersistence(sessionDir);
      await backgroundPersistence.appendTaskOutput('bash-prev0000', 'previous bash output');
      previousTasks = [
        {
          taskId: 'bash-prev0000',
          kind: 'process',
          command: 'echo previous',
          description: 'previous bash task',
          pid: 12345,
          startedAt: 1_700_000_000,
          endedAt: 1_700_000_005,
          exitCode: 0,
          status: 'completed',
        },
        {
          taskId: 'agent-prev0000',
          kind: 'agent',
          description: 'previous agent task',
          startedAt: 1_700_000_000,
          endedAt: null,
          status: 'running',
        },
      ];

      ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
      background = ctx.get(IAgentTaskService);
      loop = ctx.get(IAgentLoopService);
      loop.update({ activeToolNames: [] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        await rm(sessionDir, { recursive: true, force: true });
      }
    });

    it('RESUME: previous-session terminal and lost tasks record prompt-only turns without model requests', async () => {
      const launches: TurnStarted[] = [];
      const launchSubscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
        launches.push(event);
      });

      await restoreTaskHistory(ctx, previousTasks);
      await loop.settled();

      expect(background.getTask('agent-prev0000')?.status).toBe('lost');
      expect(launches).toHaveLength(2);
      expect(launches.every((event) => event.origin?.kind === 'task')).toBe(true);
      expect(ctx.llmCalls).toEqual([]);
      expect(loop.snapshot().activeTurnId).toBeUndefined();
      expect(loop.snapshot().hasPendingRequests).toBe(false);

      const flatContext = JSON.stringify(ctx.contextData());
      expect(flatContext).toContain('<output-file');
      expect(flatContext).not.toContain('previous bash output');
      expect(flatContext).toContain('agent-prev0000');
      expect(flatContext).toContain('bash-prev0000');
      expect(flatContext).toMatch(/task\.completed/);
      expect(flatContext).toMatch(/task\.lost/);
      expect(flatContext).not.toContain('task_resume_termination');

      ctx.mockNextResponse({ type: 'text', text: 'follow-up after resume' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after resume' }] });
      await ctx.untilTurnEnd();
      await loop.settled();
      launchSubscription.dispose();

      expect(launches).toHaveLength(3);
      expect(launches[2]?.origin).toEqual({ kind: 'user' });
      expect(ctx.llmCalls).toHaveLength(1);
      const llmHistory = JSON.stringify(ctx.llmCalls[0]!.history);
      expect(llmHistory).toContain('bash-prev0000');
      expect(llmHistory).toContain('agent-prev0000');
      expect(llmHistory).toContain('continue after resume');
    });
  });
});
