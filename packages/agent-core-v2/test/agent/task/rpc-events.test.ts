/**
 * Covers AgentTaskService event emission and notification delivery.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { IProcess } from '#/session/process/processRunner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentTaskInfo,
  IAgentTaskService,
} from '#/agent/task/task';
import { TaskStopTool } from '#/agent/task/tools/task-stop';
import {
  SubagentTask,
  type SubagentHandle,
} from '#/session/agentLifecycle/tools/subagent-task';
import { ProcessTask } from '#/os/backends/node-local/tools/process-task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IEventBus } from '#/app/event/eventBus';
import type { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  configServices,
  createTestAgent,
  externalHookServices,
  homeDirServices,
  telemetryServices,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import { executeTool, type TestExecutableToolContext } from '../../tools/fixtures/execute-tool';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from './stubs';

type FireAndForgetTrigger = IExternalHooksRunnerService['fireAndForgetTrigger'];

function immediateProcess(exitCode: number, stdoutText = ''): IProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 30000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
  };
}

function pendingProcess(): IProcess {
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
    }) as unknown as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
  };
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
  options: {
    readonly agentId?: string;
    readonly subagentType?: string;
    readonly abortController?: AbortController;
    readonly timeoutMs?: number;
  } = {},
): SubagentTask {
  const handle: SubagentHandle = {
    agentId: options.agentId ?? 'agent-child',
    profileName: options.subagentType ?? 'coder',
    completion,
  };
  const task = new SubagentTask(
    handle,
    description,
    options.abortController ?? new AbortController(),
  );
  if (options.timeoutMs !== undefined) {
    Object.defineProperty(task, 'timeoutMs', {
      value: options.timeoutMs,
      enumerable: true,
    });
  }
  return task;
}

function persistedProcess(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {},
): Extract<AgentTaskInfo, { kind: 'process' }> {
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
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'agent' }>> = {},
): Extract<AgentTaskInfo, { kind: 'agent' }> {
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

interface FakeTaskAgent {
  emitEvent: ReturnType<typeof vi.fn>;
  emittedEvents: Array<{ type: string; info?: unknown }>;
  kimiConfig?: { task?: { maxRunningTasks?: number } };
  telemetry: { track2: ReturnType<typeof vi.fn> };
  context: { appendUserMessage: ReturnType<typeof vi.fn> };
  hooks?: { fireAndForgetTrigger: FireAndForgetTrigger };
}

interface TaskServiceFixture {
  ctx: TestAgentContext;
  agent: FakeTaskAgent;
  manager: TaskServiceTestManager;
  persistence?: ReturnType<typeof createAgentTaskPersistence>;
}

type TestContextMessage = {
  readonly origin?: {
    readonly kind: string;
    readonly taskId: string;
    readonly status: string;
    readonly notificationId: string;
  };
  readonly content: readonly { readonly text: string }[];
};

function createAgentTaskService(options: {
  sessionDir?: string;
  maxRunningTasks?: number;
  hooks?: FakeTaskAgent['hooks'];
} = {}): TaskServiceFixture {
  const track = vi.fn();
  const telemetry = recordingTelemetry([]);
  vi.spyOn(telemetry, 'track2').mockImplementation(track);
  const hookEngine: Pick<IExternalHooksRunnerService, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'> | undefined = options.hooks === undefined
    ? undefined
    : {
        trigger: vi.fn().mockResolvedValue([]),
        triggerBlock: vi.fn().mockResolvedValue(undefined),
        fireAndForgetTrigger: options.hooks.fireAndForgetTrigger,
      };
  const overrides: TestAgentServiceOverride[] = [telemetryServices(telemetry)];
  if (options.sessionDir !== undefined) {
    overrides.push(homeDirServices(options.sessionDir));
  }
  const maxRunningTasks = options.maxRunningTasks;
  if (maxRunningTasks !== undefined) {
    overrides.push(configServices(() => ({
      providers: {},
      task: { maxRunningTasks },
    })));
  }
  if (hookEngine !== undefined) {
    overrides.push(externalHookServices(hookEngine));
  }
  const ctx = createTestAgent(...overrides);

  const emittedEvents: Array<{ type: string; info?: unknown }> = [];
  const events = ctx.get(IEventBus);
  const disposable = events.subscribe((event) => {
    emittedEvents.push(event as { type: string; info?: unknown });
  });

  const context = ctx.get(IAgentContextMemoryService);
  const appendHistorySpy = vi.spyOn(context, 'append');

  const agent: FakeTaskAgent = {
    emittedEvents,
    emitEvent: vi.fn((event: { type: string; info?: unknown }) => {
      emittedEvents.push(event);
    }),
    kimiConfig:
      options.maxRunningTasks === undefined
        ? undefined
        : { task: { maxRunningTasks: options.maxRunningTasks } },
    telemetry: { track2: track },
    context: { appendUserMessage: appendHistorySpy },
    hooks: options.hooks,
  };

  const persistence =
    options.sessionDir === undefined
      ? undefined
      : createAgentTaskPersistence(options.sessionDir);

  return {
    ctx,
    agent,
    manager: ctx.get(IAgentTaskService) as TaskServiceTestManager,
    persistence,
  };
}

async function cleanupSessionDir(
  sessionDir: string,
  fixture?: TaskServiceFixture,
): Promise<void> {
  if (fixture !== undefined) {
    await fixture.ctx.get(ISessionMetadata).ready;
    await fixture.ctx.dispose();
  }
  await rm(sessionDir, { recursive: true, force: true });
}

function firstAppendedContextMessage(agent: FakeTaskAgent): TestContextMessage {
  const call = agent.context.appendUserMessage.mock.calls[0] as unknown as TestContextMessage[];
  const message = call.at(-1);
  if (message === undefined) throw new Error('Expected an appended context message');
  return message;
}

function notifiedCount(ctx: TestAgentContext): number {
  return ctx.allEvents.filter((e) => e.event === 'task.notified').length;
}

async function drainNotifications(ctx: TestAgentContext): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
  await vi.waitFor(() => {
    const loop = ctx.get(IAgentLoopService);
    expect(loop.status().state).toBe('idle');
    expect(loop.hasPendingRequests()).toBe(false);
  });
}

function notificationMessageFor(agent: FakeTaskAgent, taskId: string): TestContextMessage {
  for (const call of agent.context.appendUserMessage.mock.calls as unknown as TestContextMessage[][]) {
    for (const message of call) {
      if (message.origin?.kind === 'task' && message.origin.taskId === taskId) return message;
    }
  }
  throw new Error(`Expected an appended notification message for ${taskId}`);
}

function toolContext<Input>(
  toolCallId: string,
  args: Input,
): TestExecutableToolContext<Input> {
  return {
    turnId: 0,
    toolCallId,
    args,
    signal: new AbortController().signal,
  };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

function registerProcess(
  manager: IAgentTaskService,
  proc: IProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description));
}

describe('AgentTaskService — event emission', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits task.started for process tasks', () => {
    const { agent, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'demo');

    expect(agent.emittedEvents).toContainEqual({
      type: 'task.started',
      info: expect.objectContaining({
        taskId,
        kind: 'process',
        status: 'running',
      }),
    });
    expect(agent.telemetry.track2).toHaveBeenCalledWith('background_task_created', {
      kind: 'bash',
    });
  });

  it('emits task.started for agent tasks', () => {
    const { agent, manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'agent task'),
    );

    expect(agent.emittedEvents).toContainEqual({
      type: 'task.started',
      info: expect.objectContaining({
        taskId,
        kind: 'agent',
        status: 'running',
      }),
    });
    expect(agent.telemetry.track2).toHaveBeenCalledWith('background_task_created', {
      kind: 'agent',
    });
  });

  it('emits task.terminated and telemetry on natural exit', async () => {
    const { agent, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');
    agent.telemetry.track2.mockClear();

    await manager.wait(taskId);

    expect(agent.emittedEvents).toContainEqual({
      type: 'task.terminated',
      info: expect.objectContaining({
        taskId,
        status: 'completed',
      }),
    });
    expect(agent.telemetry.track2).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({
        kind: 'process',
        duration_ms: expect.any(Number),
        status: 'completed',
      }),
    );
  });

  it('tracks failed and timed-out terminal statuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { agent, manager } = createAgentTaskService();
    const failedId = registerProcess(manager, immediateProcess(1), 'false', 'failed');
    const timedOutId = manager.registerTask(
      agentTask(new Promise(() => {}), 'slow agent', { timeoutMs: 1 }),
    );
    agent.telemetry.track2.mockClear();

    await manager.wait(failedId);
    const timedOut = manager.wait(timedOutId);
    await vi.advanceTimersByTimeAsync(5_010);
    await timedOut;

    expect(agent.telemetry.track2).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({ kind: 'process', status: 'failed' }),
    );
    expect(agent.telemetry.track2).toHaveBeenCalledWith(
      'background_task_completed',
      expect.objectContaining({ kind: 'agent', status: 'timed_out' }),
    );
  });

  it('emits task.terminated on stop', async () => {
    const { agent, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long');
    agent.emittedEvents.length = 0;

    await manager.stop(taskId, 'user');

    expect(agent.emittedEvents.filter((e) => e.type === 'task.terminated')).toEqual([
      {
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId,
          status: 'killed',
        }),
      },
    ]);
  });

  it('emits task.terminated when a restored task is marked lost', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-reconcile-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
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
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.emittedEvents).toContainEqual({
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId: 'bash-orphan00',
          status: 'lost',
        }),
      });
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });
});

describe('AgentTaskService — notification delivery', () => {
  it('delivers completed agent task notifications through an auto-launched turn', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final subagent summary' }),
        'agent task',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await turnEnd;

    const message = notificationMessageFor(agent, taskId);
    expect(message.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = message.content[0]!.text;
    expect(text).toContain('Background agent completed');
    expect(text).toContain('agent task completed.');
    expect(text).toContain('<output-file');
    expect(text).not.toContain('final subagent summary');
  });

  it('enqueues completed process task notifications into the turn flow', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo ok', 'shell task');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);

    const message = notificationMessageFor(agent, taskId);
    expect(message.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = message.content[0]!.text;
    expect(text).toContain('Background process completed');
    expect(text).toContain('shell task completed.');
  });

  it('enqueues stopped process task notifications into the turn flow', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long shell task');

    await manager.stop(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);

    const message = notificationMessageFor(agent, taskId);
    expect(message.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'killed',
      notificationId: `task:${taskId}:killed`,
    });
    expect(message.content[0]!.text).toContain(
      'Background process killed',
    );
  });

  it('TaskStopTool suppresses the real terminal notification for model-requested stops', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop test');

    const result = await executeTool(
      new TaskStopTool(manager),
      toolContext('task_stop_silent', { task_id: taskId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain('status: killed');
    expect(notifiedCount(ctx)).toBe(0);
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    expect(ctx.get(IAgentLoopService).hasPendingRequests()).toBe(false);
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'killed',
      terminalNotificationSuppressed: true,
    });
  });

  it('TaskStopTool persists stop reason and suppression across reload', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-tool-stop-'));
    let writerFixture: TaskServiceFixture | undefined;
    let readerFixture: TaskServiceFixture | undefined;
    try {
      writerFixture = createAgentTaskService({ sessionDir });
      const taskId = registerProcess(
        writerFixture.manager,
        pendingProcess(),
        'sleep 60',
        'persist stop',
      );

      const result = await executeTool(
        new TaskStopTool(writerFixture.manager),
        toolContext('task_stop_persisted', { task_id: taskId, reason: 'operator cancelled' }),
      );
      expect(result.isError ?? false).toBe(false);

      readerFixture = createAgentTaskService({ sessionDir });
      const { agent, manager: reader } = readerFixture;
      await reader.loadFromDisk();
      expect(reader.getTask(taskId)).toMatchObject({
        stopReason: 'operator cancelled',
        terminalNotificationSuppressed: true,
      });

      await reader.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
      expect(readerFixture.ctx.get(IAgentLoopService).hasPendingRequests()).toBe(false);
    } finally {
      if (readerFixture !== undefined) {
        await readerFixture.ctx.dispose();
      }
      await cleanupSessionDir(sessionDir, writerFixture);
    }
  });

  it('replays restored terminal agent task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent());
      await persistence.appendTaskOutput('agent-done0000', 'restored subagent summary');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'agent-done0000',
        status: 'completed',
        notificationId: 'task:agent-done0000:completed',
      });
      const text = message.content[0]!.text;
      expect(text).toContain('Background agent completed');
      expect(text).not.toContain('restored subagent summary');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('agent-done0000'));
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('replays restored terminal process task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess());
      await persistence.appendTaskOutput('bash-done0000', 'restored shell output');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'bash-done0000',
        status: 'completed',
        notificationId: 'task:bash-done0000:completed',
      });
      const text = message.content[0]!.text;
      expect(text).toContain('Background process completed');
      expect(text).not.toContain('restored shell output');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('bash-done0000'));
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('references persisted output without reading a tail for restored process notifications', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-tail-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const taskId = 'bash-large000';
      const largeOutput = `early-output-marker\n${'x'.repeat(8_000)}\nfinal output line`;
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess({ taskId }));
      await persistence.appendTaskOutput(taskId, largeOutput);
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      const text = message.content[0]!.text;
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile(taskId));
      expect(text).not.toContain('final output line');
      expect(text).not.toContain('early-output-marker');
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('does not replay restored notifications already marked delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const origin = {
        kind: 'task',
        taskId: 'agent-seen0000',
        status: 'completed',
        notificationId: 'task:agent-seen0000:completed',
      } as const;
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent({ taskId: 'agent-seen0000' }));
      await persistence.appendTaskOutput('agent-seen0000', 'already delivered summary');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, ctx, manager } = fixture;
      const context = ctx.get(IAgentContextMemoryService);
      context.append(
        {
          role: 'user',
          content: [{ type: 'text', text: 'already delivered' }],
          toolCalls: [],
          origin,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      agent.context.appendUserMessage.mockClear();

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('does not double-notify newly lost restored agent tasks', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-lost-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedAgent({
          taskId: 'agent-run00000',
          description: 'interrupted task',
          endedAt: null,
          status: 'running',
        }),
      );
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'agent-run00000',
        status: 'lost',
        notificationId: 'task:agent-run00000:lost',
      });
      expect(message.content[0]!.text).toContain(
        'Background agent lost',
      );
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('fires a Notification hook when a task agent notification is delivered', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => []);
    const { ctx, manager } = createAgentTaskService({
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
      expect(notifiedCount(ctx)).toBe(1);
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', expect.objectContaining({
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
    }));
  });

  it('does not let Notification hook failures interrupt notification delivery', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => {
      throw new Error('notification hook failed');
    });
    const { agent, ctx, manager } = createAgentTaskService({
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
      expect(notifiedCount(ctx)).toBe(1);
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });

    await drainNotifications(ctx);
    expect(notificationMessageFor(agent, taskId).content[0]!.text).toContain(
      'inspect repository completed.',
    );
  });

  it('fires Notification hooks for process task notifications', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => []);
    const { ctx, manager } = createAgentTaskService({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', expect.objectContaining({
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
    }));
  });
});

describe('AgentTaskService — agent recovery notification bodies', () => {
  it('failed agent task body includes resume instructions with the correct agent_id', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(
        Promise.reject(new Error('subagent crashed')),
        'inspect repository',
        { agentId: 'agent-7' },
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('agent_id="agent-7"');
    expect(text).toMatch(/Agent\(resume="agent-7"/);
    expect(text).toMatch(/agent_id.*NOT source_id|source_id.*NOT agent_id/);
  });

  it('completed agent task body does not add resume instructions', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'all good' }),
        'inspect repository',
        { agentId: 'agent-8' },
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('agent_id="agent-8"');
    expect(text).not.toMatch(/Agent\(resume="agent-8"/);
  });

  it('process task body never mentions resume', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(1), 'false', 'shell');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).not.toContain('agent_id=');
    expect(text).not.toMatch(/Agent\(resume=/);
    expect(text).toContain(`source_id="${taskId}"`);
  });
});
