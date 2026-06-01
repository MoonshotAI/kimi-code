/**
 * Covers: BackgroundManager (the agent-aware subclass).
 *
 * Confirms that BPM lifecycle transitions are translated into
 * agent.emitEvent({ type: 'background.task.*' }) so SDK / TUI
 * subscribers can react in real time without polling.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentBackgroundTask, BackgroundManager } from '../../src/agent/background';
import type { AgentEvent } from '../../src/rpc/events';
import { appendTaskOutput, writeTask } from '../../src/agent/background/persist';

interface FakeAgent {
  emitEvent: (event: AgentEvent) => void;
  emittedEvents: AgentEvent[];
  hooks?: { fireAndForgetTrigger: ReturnType<typeof vi.fn> };
  turn: {
    hasActiveTurn: boolean;
    waitForCurrentTurn: () => Promise<void>;
    steer: (...args: unknown[]) => number | null;
  };
  context: { appendUserMessage: (...args: unknown[]) => void };
  records: { restoring: boolean; logRecord: (record: unknown) => void };
  telemetry: { track: ReturnType<typeof vi.fn> };
  background: BackgroundManager;
}

function makeAgent(options: { hooks?: FakeAgent['hooks'] } = {}): FakeAgent {
  const emitted: AgentEvent[] = [];
  const agent = {
    emittedEvents: emitted,
    emitEvent: (event: AgentEvent) => {
      emitted.push(event);
    },
    hooks: options.hooks,
    turn: {
      hasActiveTurn: false,
      waitForCurrentTurn: vi.fn(() => Promise.resolve()),
      steer: vi.fn(() => 1),
    },
    context: { appendUserMessage: vi.fn() },
    records: { restoring: false, logRecord: vi.fn() },
    telemetry: { track: vi.fn() },
  } as unknown as FakeAgent;
  const manager = new BackgroundManager(agent as never);
  agent.background = manager;
  return agent;
}

function immediateProcess(exitCode: number): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 30000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 99999,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      if (currentExitCode === null) {
        currentExitCode = 143;
        resolveWait(143);
      }
    }) as unknown as KaosProcess['kill'],
  };
}

describe('BackgroundManager — RPC event emission', () => {
  let agent: FakeAgent;

  beforeEach(() => {
    agent = makeAgent();
  });

  afterEach(() => {
    agent.background._reset();
  });

  it('emits background.task.started on register()', () => {
    const taskId = agent.background.register(pendingProcess(), 'sleep 60', 'demo');

    const started = agent.emittedEvents.filter((e) => e.type === 'background.task.started');
    expect(started.length).toBe(1);
    expect(started[0]!.info.taskId).toBe(taskId);
    expect(started[0]!.info.status).toBe('running');
    expect(agent.telemetry.track).toHaveBeenCalledWith('background_task_created', {
      kind: 'bash',
    });
  });

  it('emits background.task.started on registerAgentTask()', () => {
    const taskId = agent.background.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'agent task'));

    const started = agent.emittedEvents.filter((e) => e.type === 'background.task.started');
    expect(started.length).toBe(1);
    expect(started[0]!.info.taskId).toBe(taskId);
    expect(taskId).toMatch(/^agent-/);
    expect(agent.telemetry.track).toHaveBeenCalledWith('background_task_created', {
      kind: 'agent',
    });
  });

  it('emits background.task.terminated on natural exit', async () => {
    agent.background.register(immediateProcess(0), 'echo', 'done');
    await new Promise((r) => setTimeout(r, 20));

    const terminated = agent.emittedEvents.filter((e) => e.type === 'background.task.terminated');
    expect(terminated.length).toBe(1);
    expect(terminated[0]!.info.status).toBe('completed');
  });

  it('tracks successful task completion with duration and no reason', async () => {
    const taskId = agent.background.register(immediateProcess(0), 'echo ok', 'done');
    agent.telemetry.track.mockClear();

    await agent.background.waitForTerminal(taskId);

    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        kind: 'bash',
        success: true,
        duration_s: expect.any(Number),
      }),
    );
    expect(agent.telemetry.track.mock.calls[0]?.[1]).not.toHaveProperty('reason');
  });

  it('tracks failed task completion with reason=error', async () => {
    const taskId = agent.background.register(immediateProcess(1), 'false', 'failed');
    agent.telemetry.track.mockClear();

    await agent.background.waitForTerminal(taskId);

    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        kind: 'bash',
        success: false,
        reason: 'error',
        duration_s: expect.any(Number),
      }),
    );
  });

  it('tracks timed-out agent tasks with reason=timeout', async () => {
    const taskId = agent.background.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'slow agent', {
      timeoutMs: 1,
    }));
    agent.telemetry.track.mockClear();

    await agent.background.waitForTerminal(taskId);

    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        kind: 'agent',
        success: false,
        reason: 'timeout',
        duration_s: expect.any(Number),
      }),
    );
  });

  it('emits background.task.terminated on stop()', async () => {
    const taskId = agent.background.register(pendingProcess(), 'sleep 60', 'long');
    agent.emittedEvents.length = 0;

    await agent.background.stop(taskId, 'user');

    const terminated = agent.emittedEvents.filter((e) => e.type === 'background.task.terminated');
    expect(terminated.length).toBe(1);
    expect(terminated[0]!.info.status).toBe('killed');
  });

  it('emits background.task.terminated when a restored task is marked lost', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-reconcile-'));
    try {
      agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'bash-orphan00',
        command: 'sleep 60',
        description: 'orphan task',
        pid: 99999,
        started_at: 1_700_000_000,
        ended_at: null,
        exit_code: null,
        status: 'running',
      });
      agent.emittedEvents.length = 0;

      await agent.background.loadFromDisk();
      await agent.background.reconcile();

      const terminated = agent.emittedEvents.filter(
        (e) => e.type === 'background.task.terminated',
      );
      expect(terminated.length).toBe(1);
      expect(terminated[0]!.info.taskId).toBe('bash-orphan00');
      expect(terminated[0]!.info.status).toBe('lost');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('steers completed agent task notifications into the turn flow', async () => {
    const taskId = agent.background.registerTask(new AgentBackgroundTask(
      Promise.resolve({ result: 'final subagent summary' }),
      'agent task',
    ));
    await agent.background.waitForTerminal(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    expect(agent.turn.waitForCurrentTurn).not.toHaveBeenCalled();
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();

    const [content, origin] = vi.mocked(agent.turn.steer).mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    expect((content as Array<{ text: string }>)[0]!.text).toContain(
      'Background agent completed',
    );
    expect((content as Array<{ text: string }>)[0]!.text).toContain('final subagent summary');
  });

  it('steers completed bash task notifications into the turn flow', async () => {
    const taskId = agent.background.register(immediateProcess(0), 'echo ok', 'shell task');

    await agent.background.waitForTerminal(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    expect(agent.turn.waitForCurrentTurn).not.toHaveBeenCalled();
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();

    const [content, origin] = vi.mocked(agent.turn.steer).mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    expect((content as Array<{ text: string }>)[0]!.text).toContain(
      'Background task completed',
    );
    expect((content as Array<{ text: string }>)[0]!.text).toContain('shell task completed.');
  });

  it('steers stopped bash task notifications into the turn flow', async () => {
    const taskId = agent.background.register(pendingProcess(), 'sleep 60', 'long shell task');

    await agent.background.stop(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content, origin] = vi.mocked(agent.turn.steer).mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'killed',
      notificationId: `task:${taskId}:killed`,
    });
    expect((content as Array<{ text: string }>)[0]!.text).toContain('Background task killed');
    expect((content as Array<{ text: string }>)[0]!.text).toContain('long shell task killed.');
  });

  it('queues background agent notifications without waiting for an active turn', async () => {
    agent.turn.hasActiveTurn = true;
    const taskId = agent.background.registerTask(new AgentBackgroundTask(
      Promise.resolve({ result: 'active turn summary' }),
      'agent task',
    ));
    await agent.background.waitForTerminal(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    expect(agent.turn.waitForCurrentTurn).not.toHaveBeenCalled();
    const [content, origin] = vi.mocked(agent.turn.steer).mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    expect((content as Array<{ text: string }>)[0]!.text).toContain('active turn summary');
  });

  it('replays restored terminal agent task notifications when they were not delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    try {
      agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'agent-done0000',
        command: '[agent] restored task',
        description: 'restored task',
        pid: 0,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_010,
        exit_code: 0,
        status: 'completed',
      });
      await appendTaskOutput(sessionDir, 'agent-done0000', 'restored subagent summary');

      await agent.background.loadFromDisk();
      const result = await agent.background.reconcile();

      expect(result.lost).toEqual([]);
      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = vi.mocked(agent.context.appendUserMessage).mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'agent-done0000',
        status: 'completed',
        notificationId: 'task:agent-done0000:completed',
      });
      expect((content as Array<{ text: string }>)[0]!.text).toContain(
        'Background agent completed',
      );
      expect((content as Array<{ text: string }>)[0]!.text).toContain('restored subagent summary');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('replays restored terminal bash task notifications when they were not delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-replay-'));
    try {
      agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'bash-done0000',
        command: 'echo done',
        description: 'restored shell task',
        pid: 12345,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_010,
        exit_code: 0,
        status: 'completed',
      });
      await appendTaskOutput(sessionDir, 'bash-done0000', 'restored shell output');

      await agent.background.loadFromDisk();
      const result = await agent.background.reconcile();

      expect(result.lost).toEqual([]);
      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = vi.mocked(agent.context.appendUserMessage).mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'bash-done0000',
        status: 'completed',
        notificationId: 'task:bash-done0000:completed',
      });
      expect((content as Array<{ text: string }>)[0]!.text).toContain(
        'Background task completed',
      );
      expect((content as Array<{ text: string }>)[0]!.text).toContain('restored shell output');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('reads only a bounded output tail for restored bash task notifications', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-tail-'));
    try {
      const taskId = 'bash-large000';
      const largeOutput = `early-output-marker\n${'x'.repeat(8_000)}\nfinal output line`;
      agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: taskId,
        command: 'generate large output',
        description: 'large shell task',
        pid: 12345,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_010,
        exit_code: 0,
        status: 'completed',
      });
      await appendTaskOutput(sessionDir, taskId, largeOutput);
      const readOutputSpy = vi.spyOn(agent.background, 'readOutput');
      const snapshotSpy = vi.spyOn(agent.background, 'getOutputSnapshot');

      await agent.background.loadFromDisk();
      await agent.background.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(readOutputSpy).not.toHaveBeenCalled();
      expect(snapshotSpy).toHaveBeenCalledWith(taskId, expect.any(Number));
      expect(snapshotSpy.mock.calls[0]![1]).toBeLessThan(largeOutput.length);
      const [content] = vi.mocked(agent.context.appendUserMessage).mock.calls[0]!;
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('final output line');
      expect(text).not.toContain('early-output-marker');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not replay restored agent task notifications already marked delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    try {
      const origin = {
        kind: 'background_task',
        taskId: 'agent-seen0000',
        status: 'completed',
        notificationId: 'task:agent-seen0000:completed',
      } as const;
      agent.background.markDeliveredNotification(origin);
      agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'agent-seen0000',
        command: '[agent] already delivered',
        description: 'already delivered',
        pid: 0,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_010,
        exit_code: 0,
        status: 'completed',
      });
      await appendTaskOutput(sessionDir, 'agent-seen0000', 'already delivered summary');

      await agent.background.loadFromDisk();
      await agent.background.reconcile();

      expect(agent.turn.steer).not.toHaveBeenCalled();
      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not double-notify newly lost restored agent tasks', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    try {
      agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'agent-run00000',
        command: '[agent] interrupted task',
        description: 'interrupted task',
        pid: 0,
        started_at: 1_700_000_000,
        ended_at: null,
        exit_code: null,
        status: 'running',
      });

      await agent.background.loadFromDisk();
      const result = await agent.background.reconcile();

      expect(result.lost).toEqual(['agent-run00000']);
      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = vi.mocked(agent.context.appendUserMessage).mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'agent-run00000',
        status: 'lost',
        notificationId: 'task:agent-run00000:lost',
      });
      expect((content as Array<{ text: string }>)[0]!.text).toContain('Background agent lost');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('fires a Notification hook when a background agent notification is delivered', async () => {
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([]));
    agent = makeAgent({ hooks: { fireAndForgetTrigger } });

    const taskId = agent.background.registerTask(new AgentBackgroundTask(
      Promise.resolve({ result: 'final agent output' }),
      'inspect repository',
    ));
    await agent.background.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', {
      matcherValue: 'task.completed',
      inputData: {
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background agent completed',
        body: 'inspect repository completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      },
    });
  });

  it('does not let Notification hook failures interrupt background notification delivery', async () => {
    const fireAndForgetTrigger = vi.fn(() => {
      throw new Error('notification hook failed');
    });
    agent = makeAgent({ hooks: { fireAndForgetTrigger } });

    const taskId = agent.background.registerTask(new AgentBackgroundTask(
      Promise.resolve({ result: 'final agent output' }),
      'inspect repository',
    ));
    await agent.background.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(agent.turn.steer).toHaveBeenCalledWith(
      [
        {
          type: 'text',
          text: expect.stringContaining(`source_id="${taskId}"`),
        },
      ],
      {
        kind: 'background_task',
        taskId,
        status: 'completed',
        notificationId: `task:${taskId}:completed`,
      },
    );
  });

  it('fires Notification hooks for bash background task notifications', async () => {
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([]));
    agent = makeAgent({ hooks: { fireAndForgetTrigger } });

    const taskId = agent.background.register(immediateProcess(0), 'echo', 'done');
    await agent.background.waitForTerminal(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', {
      matcherValue: 'task.completed',
      inputData: {
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background task completed',
        body: 'done completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      },
    });
  });

  it('tracks stopped tasks as killed even without a stop reason', async () => {
    const taskId = agent.background.register(pendingProcess(), 'sleep 60', 'long');
    agent.telemetry.track.mockClear();

    await agent.background.stop(taskId);

    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        success: false,
        reason: 'killed',
      }),
    );
  });

  describe('agent task failure body — actionable recovery instructions', () => {
    // For agent-* tasks that end non-successfully (lost / failed / killed),
    // the notification body must carry enough information for the LLM to
    // recover via `Agent(resume=...)` without digging through old context.
    // Three things must land in the body:
    //   1. The agent_id (NOT the task_id / source_id) — that is what
    //      `subagentHost.resume` actually takes.
    //   2. An explicit disambiguation between agent_id and source_id —
    //      they look alike and the LLM regularly confuses them.
    //   3. The notification must also surface agent_id as a structural
    //      XML attribute, not just buried in prose.
    it('failed agent task body includes resume instructions with the correct agent_id', async () => {
      // Promise.reject (non-AbortError) routes through the registerAgentTask
      // `.catch` branch and lands at status `failed`, which is the same
      // agent-* failure branch reconcile uses for `lost` tasks.
      const taskId = agent.background.registerTask(new AgentBackgroundTask(
        Promise.reject(new Error('subagent crashed')),
        'inspect repository',
        { agentId: 'agent-7' },
      ));
      await agent.background.waitForTerminal(taskId);

      await vi.waitFor(() => {
        expect(agent.turn.steer).toHaveBeenCalled();
      });
      const [content] = vi.mocked(agent.turn.steer).mock.calls[0]!;
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('agent_id="agent-7"');
      expect(text).toMatch(/Agent\(resume="agent-7"/);
      expect(text).toMatch(/agent_id.*not.*source_id|source_id.*not.*agent_id/i);
    });

    it('completed agent task body does NOT add resume instructions', async () => {
      const taskId = agent.background.registerTask(new AgentBackgroundTask(
        Promise.resolve({ result: 'all good' }),
        'inspect repository',
        { agentId: 'agent-8' },
      ));
      await agent.background.wait(taskId);

      await vi.waitFor(() => {
        expect(agent.turn.steer).toHaveBeenCalled();
      });
      const [content] = vi.mocked(agent.turn.steer).mock.calls[0]!;
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('agent_id="agent-8"');
      // Recovery prose belongs to failure bodies only.
      expect(text).not.toMatch(/Agent\(resume="agent-8"/);
    });

    it('bash task body never mentions resume — bash background tasks are not resumable', async () => {
      const taskId = agent.background.register(immediateProcess(1), 'false', 'shell');
      await agent.background.waitForTerminal(taskId);

      await vi.waitFor(() => {
        expect(agent.turn.steer).toHaveBeenCalled();
      });
      const [content] = vi.mocked(agent.turn.steer).mock.calls[0]!;
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).not.toContain('agent_id=');
      expect(text).not.toMatch(/Agent\(resume=/);
    });
  });

  // Note: the `records.restoring` guard is enforced inside `Agent.emitEvent`
  // (see agent/index.ts). BackgroundManager unconditionally forwards
  // lifecycle events to the agent; suppression is the agent's job.
});
