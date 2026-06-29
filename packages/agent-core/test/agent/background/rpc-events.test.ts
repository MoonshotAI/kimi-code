/**
 * Covers BackgroundManager event emission and notification delivery.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTaskPersistence,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import {
  agentTask,
  createBackgroundManager,
  registerProcess,
} from './helpers';

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 30000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
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
      if (currentExitCode !== null) return;
      currentExitCode = 143;
      resolveWait(143);
    }) as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function persistedProcess(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'process' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-done0000',
    kind: 'process',
    command: 'echo done',
    description: 'restored shell task',
    pid: 12345,
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    exitCode: 0,
    status: 'completed',
    ...overrides,
  };
}

function persistedAgent(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'agent' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'agent' }> {
  return {
    taskId: 'agent-done0000',
    kind: 'agent',
    description: 'restored task',
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    status: 'completed',
    agentId: 'agent-session-id',
    subagentType: 'coder',
    ...overrides,
  };
}

describe('BackgroundManager — event emission', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits background.task.started for process tasks', () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'demo');

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.started',
      info: expect.objectContaining({
        taskId,
        kind: 'process',
        status: 'running',
      }),
    });
    expect(agent.telemetry.track).toHaveBeenCalledWith('background_task_created', {
      kind: 'bash',
    });
  });

  it('emits background.task.started for agent tasks', () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'agent task'),
    );

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.started',
      info: expect.objectContaining({
        taskId,
        kind: 'agent',
        status: 'running',
      }),
    });
    expect(agent.telemetry.track).toHaveBeenCalledWith('background_task_created', {
      kind: 'agent',
    });
  });

  it('emits background.task.terminated and telemetry on natural exit', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');
    agent.telemetry.track.mockClear();

    await manager.wait(taskId);

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId,
        status: 'completed',
      }),
    });
    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        kind: 'process',
        duration_ms: expect.any(Number),
        status: 'completed',
      }),
    );
  });

  it('sends null duration_ms when a terminal task has no endedAt', () => {
    const { agent, manager } = createBackgroundManager();
    agent.telemetry.track.mockClear();

    const info: BackgroundTaskInfo = {
      taskId: 'task-1',
      description: 'lost task',
      status: 'lost',
      kind: 'process',
      command: 'sleep 60',
      pid: 123,
      exitCode: null,
      startedAt: 100,
      endedAt: null,
    };

    (manager as unknown as { emitTaskTerminated: (info: BackgroundTaskInfo) => void }).emitTaskTerminated(
      info,
    );

    const trackCall = agent.telemetry.track.mock.calls.find(
      (call) => call[0] === 'background_task_completed',
    );
    expect(trackCall?.[1]).toMatchObject({ kind: 'process', status: 'lost' });
    expect(trackCall?.[1]?.duration_ms).toBeNull();
  });

  it('tracks failed and timed-out terminal statuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { agent, manager } = createBackgroundManager();
    const failedId = registerProcess(manager, immediateProcess(1), 'false', 'failed');
    const timedOutId = manager.registerTask(
      agentTask(new Promise(() => {}), 'slow agent'),
      { timeoutMs: 1 },
    );
    agent.telemetry.track.mockClear();

    await manager.wait(failedId);
    const timedOut = manager.wait(timedOutId);
    await vi.advanceTimersByTimeAsync(5_010);
    await timedOut;

    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({ kind: 'process', status: 'failed' }),
    );
    expect(agent.telemetry.track).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({ kind: 'agent', status: 'timed_out' }),
    );
  });

  it('emits background.task.terminated on stop', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long');
    agent.emittedEvents.length = 0;

    await manager.stop(taskId, 'user');

    expect(agent.emittedEvents).toEqual([
      {
        type: 'background.task.terminated',
        info: expect.objectContaining({
          taskId,
          status: 'killed',
        }),
      },
    ]);
  });

  it('emits background.task.terminated when a restored task is marked lost', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-reconcile-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-orphan00',
          command: 'sleep 60',
          description: 'orphan task',
          endedAt: null,
          exitCode: null,
          status: 'running',
        }),
      );
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.emittedEvents).toContainEqual({
        type: 'background.task.terminated',
        info: expect.objectContaining({
          taskId: 'bash-orphan00',
          status: 'lost',
        }),
      });
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('BackgroundManager — notification delivery', () => {
  it('steers completed agent task notifications into the turn flow', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final subagent summary' }),
        'agent task',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    const [content, origin] = agent.turn.steer.mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Background agent completed');
    expect(text).toContain('final subagent summary');
    expect(text).toContain('<output-preview');
    expect(text).not.toContain('<output-file');
  });

  it('steers completed process task notifications into the turn flow', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo ok', 'shell task');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content, origin] = agent.turn.steer.mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Background process completed');
    expect(text).toContain('shell task completed.');
  });

  it('uses a bounded output preview when no persisted task output exists', async () => {
    const { agent, manager } = createBackgroundManager();
    const output = `early-output-marker\n${'x'.repeat(4_000)}\nfinal subagent line`;
    const taskId = manager.registerTask(agentTask(Promise.resolve({ result: output }), 'agent task'));

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content] = agent.turn.steer.mock.calls[0]!;
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('<output-preview');
    expect(text).toContain('truncated="true"');
    expect(text).toContain('final subagent line');
    expect(text).not.toContain('early-output-marker');
    expect(text).not.toContain('<output-file');
  });

  it('steers stopped process task notifications into the turn flow', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long shell task');

    await manager.stop(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalledTimes(1);
    });
    const [content, origin] = agent.turn.steer.mock.calls[0]!;
    expect(origin).toEqual({
      kind: 'background_task',
      taskId,
      status: 'killed',
      notificationId: `task:${taskId}:killed`,
    });
    expect((content as Array<{ text: string }>)[0]!.text).toContain(
      'Background process killed',
    );
  });

  it('replays restored terminal agent task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent());
      await persistence.appendTaskOutput('agent-done0000', 'restored subagent summary');
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = agent.context.appendUserMessage.mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'agent-done0000',
        status: 'completed',
        notificationId: 'task:agent-done0000:completed',
      });
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('Background agent completed');
      expect(text).not.toContain('restored subagent summary');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('agent-done0000'));
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('replays restored terminal process task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-replay-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess());
      await persistence.appendTaskOutput('bash-done0000', 'restored shell output');
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = agent.context.appendUserMessage.mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'bash-done0000',
        status: 'completed',
        notificationId: 'task:bash-done0000:completed',
      });
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('Background process completed');
      expect(text).not.toContain('restored shell output');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('bash-done0000'));
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('references persisted output without reading a tail for restored process notifications', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-tail-'));
    try {
      const taskId = 'bash-large000';
      const largeOutput = `early-output-marker\n${'x'.repeat(8_000)}\nfinal output line`;
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess({ taskId }));
      await persistence.appendTaskOutput(taskId, largeOutput);
      const { agent, manager } = createBackgroundManager({ sessionDir });
      const readOutputSpy = vi.spyOn(manager, 'readOutput');
      const snapshotSpy = vi.spyOn(manager, 'getOutputSnapshot');

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(readOutputSpy).not.toHaveBeenCalled();
      expect(snapshotSpy).toHaveBeenCalledWith(taskId, expect.any(Number));
      expect(snapshotSpy.mock.calls[0]![1]).toBe(0);
      const [content] = agent.context.appendUserMessage.mock.calls[0]!;
      const text = (content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile(taskId));
      expect(text).not.toContain('final output line');
      expect(text).not.toContain('early-output-marker');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not replay restored notifications already marked delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    try {
      const origin = {
        kind: 'background_task',
        taskId: 'agent-seen0000',
        status: 'completed',
        notificationId: 'task:agent-seen0000:completed',
      } as const;
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent({ taskId: 'agent-seen0000' }));
      await persistence.appendTaskOutput('agent-seen0000', 'already delivered summary');
      const { agent, manager } = createBackgroundManager({ sessionDir });
      manager.markDeliveredNotification(origin);

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.turn.steer).not.toHaveBeenCalled();
      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not double-notify newly lost restored agent tasks', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-lost-'));
    try {
      const persistence = new BackgroundTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedAgent({
          taskId: 'agent-run00000',
          description: 'interrupted task',
          endedAt: null,
          status: 'running',
        }),
      );
      const { agent, manager } = createBackgroundManager({ sessionDir });

      await manager.loadFromDisk();
      await manager.reconcile();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      expect(agent.turn.steer).not.toHaveBeenCalled();
      const [content, origin] = agent.context.appendUserMessage.mock.calls[0]!;
      expect(origin).toEqual({
        kind: 'background_task',
        taskId: 'agent-run00000',
        status: 'lost',
        notificationId: 'task:agent-run00000:lost',
      });
      expect((content as Array<{ text: string }>)[0]!.text).toContain(
        'Background agent lost',
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('fires a Notification hook when a background agent notification is delivered', async () => {
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([]));
    const { agent, manager } = createBackgroundManager({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final agent output' }),
        'inspect repository',
      ),
    );

    await manager.wait(taskId);

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

  it('does not let Notification hook failures interrupt notification delivery', async () => {
    const fireAndForgetTrigger = vi.fn(() => {
      throw new Error('notification hook failed');
    });
    const { agent, manager } = createBackgroundManager({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final agent output' }),
        'inspect repository',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
  });

  it('fires Notification hooks for process task notifications', async () => {
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([]));
    const { agent, manager } = createBackgroundManager({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', {
      matcherValue: 'task.completed',
      inputData: {
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: 'done completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      },
    });
  });
});

describe('BackgroundManager — agent recovery notification bodies', () => {
  it('failed agent task body includes resume instructions with the correct agent_id', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(
        Promise.reject(new Error('subagent crashed')),
        'inspect repository',
        { agentId: 'agent-7' },
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
    });
    const [content] = agent.turn.steer.mock.calls[0]!;
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('agent_id="agent-7"');
    expect(text).toMatch(/Agent\(resume="agent-7"/);
    expect(text).toMatch(/agent_id.*NOT source_id|source_id.*NOT agent_id/);
  });

  it('completed agent task body does not add resume instructions', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'all good' }),
        'inspect repository',
        { agentId: 'agent-8' },
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
    });
    const [content] = agent.turn.steer.mock.calls[0]!;
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('agent_id="agent-8"');
    expect(text).not.toMatch(/Agent\(resume="agent-8"/);
  });

  it('process task body never mentions resume', async () => {
    const { agent, manager } = createBackgroundManager();
    const taskId = registerProcess(manager, immediateProcess(1), 'false', 'shell');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(agent.turn.steer).toHaveBeenCalled();
    });
    const [content] = agent.turn.steer.mock.calls[0]!;
    const text = (content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain('agent_id=');
    expect(text).not.toMatch(/Agent\(resume=/);
    expect(text).toContain(`source_id="${taskId}"`);
  });
});
