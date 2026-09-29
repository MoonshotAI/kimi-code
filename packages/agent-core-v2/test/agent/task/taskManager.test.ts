import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { IHostProcess } from '#/os/interface/hostProcess';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTaskInfo,
} from '#/agent/task/task';
import {
  SubagentTask,
  type SubagentHandle,
} from '#/agent/tools/agent/subagent-task';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { MonitorProcessTask } from '#/agent/tools/task/monitor/monitorTool';
import { IAgentLoopService, type LoopNotify, type LoopNotifyHandle } from '#/agent/loop/loop';
import {
  TASK_EVENT_BATCH_MS,
  TASK_EVENT_MAX_BATCH_LINES,
  TASK_EVENT_MAX_LINE_CHARS,
  TASK_EVENT_MAX_LINES_PER_WINDOW,
  type TaskEventBatch,
  TaskEventStream,
} from '#/agent/task/taskEvents';
import { isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  configServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from './stubs';

const MiB = 1024 * 1024;
const LIMIT_BYTES = 16 * MiB;

interface TaskServiceFixture {
  ctx: TestAgentContext;
  manager: TaskServiceTestManager;
  persistence?: ReturnType<typeof createAgentTaskPersistence>;
}

function createAgentTaskService(options: {
  sessionDir?: string;
  maxRunningTasks?: number;
} = {}): TaskServiceFixture {
  const persistence =
    options.sessionDir === undefined
      ? undefined
      : createAgentTaskPersistence(options.sessionDir);
  const overrides: TestAgentServiceOverride[] = [];
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
  const ctx = createTestAgent(...overrides);
  return {
    ctx,
    manager: ctx.get(IAgentTaskService) as TaskServiceTestManager,
    persistence,
  };
}

function registerProcess(
  manager: IAgentTaskService,
  proc: IHostProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description));
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
  options: {
    readonly agentId?: string;
    readonly subagentType?: string;
    readonly parentToolCallId?: string;
    readonly abortController?: AbortController;
    readonly timeoutMs?: number;
  } = {},
): SubagentTask {
  const handle: SubagentHandle = {
    agentId: options.agentId ?? 'agent-child',
    profileName: options.subagentType ?? 'coder',
    parentToolCallId: options.parentToolCallId,
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

async function waitForTerminal(
  manager: IAgentTaskService,
  taskId: string,
  timeoutMs = 30_000,
): Promise<AgentTaskInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const info = await manager.wait(taskId, 5);
    if (
      info?.status === 'completed' ||
      info?.status === 'failed' ||
      info?.status === 'timed_out' ||
      info?.status === 'killed' ||
      info?.status === 'lost'
    ) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return manager.getTask(taskId);
}

async function waitForOutput(
  manager: IAgentTaskService,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}

function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function rejectedProcess(error: Error): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 99999,
    exitCode: null,
    wait: vi.fn().mockRejectedValue(error) as IHostProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function processWithStdoutError(message = 'stdout read failed'): IHostProcess {
  const stdout = new PassThrough();
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: Readable.from([]),
    pid: 99998,
    exitCode: 0,
    wait: vi.fn(async () => {
      stdout.destroy(new Error(message));
      return 0;
    }) as IHostProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function processWithStdoutErrorBeforeWait(message = 'stdout read failed'): {
  proc: IHostProcess;
  failStdout: () => void;
  resolveWait: (exitCode: number) => void;
} {
  const stdout = new PassThrough();
  let currentExitCode: number | null = null;
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  return {
    proc: {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr: Readable.from([]),
      pid: 99997,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: vi.fn(() => waitPromise) as IHostProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    },
    failStdout: () => {
      stdout.destroy(new Error(message));
    },
    resolveWait: (exitCode) => {
      currentExitCode = exitCode;
      resolveWait(exitCode);
    },
  };
}

function pendingProcess(exitOnKill = 143): {
  proc: IHostProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode !== null) return;
    currentExitCode = exitOnKill;
    resolveWait(exitOnKill);
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return { proc, killSpy };
}

function streamingProcess(chunks: string[]): {
  proc: IHostProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  const stdout = Readable.from(chunks);
  const stderr = Readable.from([]);
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  stdout.on('end', () => {
    currentExitCode = 0;
    resolveWait(0);
  });
  const killSpy = vi.fn(async (signal: NodeJS.Signals) => {
    if (currentExitCode !== null) return;
    currentExitCode = signal === 'SIGKILL' ? 137 : 143;
    stdout.destroy();
    resolveWait(currentExitCode);
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 54325,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return { proc, killSpy };
}

function sigtermIgnoringProcess(chunks: string[]): {
  proc: IHostProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  const stdout = Readable.from(chunks);
  const stderr = Readable.from([]);
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  stdout.on('end', () => {
    currentExitCode = 0;
    resolveWait(0);
  });
  const killSpy = vi.fn(async (signal: NodeJS.Signals) => {
    if (signal !== 'SIGKILL' || currentExitCode !== null) return;
    currentExitCode = 137;
    stdout.destroy();
    resolveWait(137);
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 54326,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return { proc, killSpy };
}

function manuallyResolvedProcess(): {
  proc: IHostProcess;
  killSpy: ReturnType<typeof vi.fn>;
  resolve: (exitCode: number) => void;
} {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn().mockResolvedValue(undefined);
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54324,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return {
    proc,
    killSpy,
    resolve: (exitCode) => {
      if (currentExitCode !== null) return;
      currentExitCode = exitCode;
      resolveWait(exitCode);
    },
  };
}

function processWithVisibleExitCodeBeforeWait(exitCode = 143): {
  proc: IHostProcess;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54322,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => new Promise<number>(() => {}),
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return {
    proc,
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

describe('AgentTaskService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers process tasks and exposes process metadata', () => {
    const { manager } = createAgentTaskService();
    const proc = immediateProcess(0);

    const taskId = registerProcess(manager, proc, 'echo hello', 'test echo');

    expect(taskId).toMatch(/^bash-[0-9a-z]{8}$/);
    expect(manager.getTask(taskId)).toMatchObject({
      taskId,
      kind: 'process',
      command: 'echo hello',
      description: 'test echo',
      pid: proc.pid,
      status: 'running',
    });
  });

  it('registers agent tasks and exposes agent metadata', () => {
    const { manager } = createAgentTaskService();

    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'investigate bug', {
        agentId: 'agent-child',
        subagentType: 'coder',
        parentToolCallId: 'call-parent-1',
      }),
    );

    expect(taskId).toMatch(/^agent-[0-9a-z]{8}$/);
    expect(manager.getTask(taskId)).toMatchObject({
      taskId,
      kind: 'agent',
      description: 'investigate bug',
      agentId: 'agent-child',
      subagentType: 'coder',
      parentToolCallId: 'call-parent-1',
      status: 'running',
    });
  });

  it('tracks foreground tasks and releases their waiter when detached', async () => {
    const { manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'foreground agent'),
      { detached: false },
    );

    expect(manager.getTask(taskId)).toMatchObject({
      detached: false,
    });

    const waiting = manager.waitForForegroundRelease(taskId);
    await Promise.resolve();

    expect(manager.detach(taskId)).toMatchObject({
      taskId,
      detached: true,
    });
    await expect(waiting).resolves.toBe('detached');
  });

  it('releases foreground waiters when a foreground task completes', async () => {
    const { manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(Promise.resolve({ result: 'done' }), 'foreground agent'),
      { detached: false },
    );

    await expect(manager.waitForForegroundRelease(taskId)).resolves.toBe('terminal');
    expect(manager.getTask(taskId)).toMatchObject({
      detached: false,
      status: 'completed',
    });
  });

  it('stops foreground tasks from their register-time signal', async () => {
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess();
    const controller = new AbortController();
    const taskId = manager.registerTask(
      new ProcessTask(proc, 'sleep 10', 'foreground process'),
      {
        detached: false,
        signal: controller.signal,
      },
    );

    const waiting = manager.waitForForegroundRelease(taskId);
    controller.abort();

    await expect(waiting).resolves.toBe('terminal');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'killed',
      stopReason: 'Aborted by the user',
    });
  });

  it('keeps a detached process task running when the register-time signal aborts', async () => {
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess();
    const controller = new AbortController();
    const taskId = manager.registerTask(
      new ProcessTask(proc, 'sleep 10', 'foreground process'),
      {
        detached: false,
        signal: controller.signal,
      },
    );

    const waiting = manager.waitForForegroundRelease(taskId);
    expect(manager.detach(taskId)).toMatchObject({ detached: true });
    controller.abort();

    await expect(waiting).resolves.toBe('detached');
    expect(killSpy).not.toHaveBeenCalled();
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'running',
      detached: true,
    });
  });

  it('forwards foreground signal abort reasons to agent task controllers', async () => {
    const { manager } = createAgentTaskService();
    const foregroundController = new AbortController();
    const subagentController = new AbortController();
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      subagentController.signal.addEventListener(
        'abort',
        () => {
          reject(subagentController.signal.reason);
        },
        { once: true },
      );
    });
    const taskId = manager.registerTask(
      agentTask(completion, 'foreground agent', { abortController: subagentController }),
      {
        detached: false,
        signal: foregroundController.signal,
      },
    );

    foregroundController.abort(userCancellationReason());

    const info = await manager.wait(taskId);
    expect(info).toMatchObject({
      status: 'killed',
      stopReason: 'Aborted by the user',
    });
    expect(isUserCancellation(subagentController.signal.reason)).toBe(true);
  });

  it('does not forward register-time signal aborts to a detached agent task', async () => {
    const { manager } = createAgentTaskService();
    const foregroundController = new AbortController();
    const subagentController = new AbortController();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'foreground agent', {
        abortController: subagentController,
      }),
      {
        detached: false,
        signal: foregroundController.signal,
      },
    );

    expect(manager.detach(taskId)).toMatchObject({ detached: true });
    foregroundController.abort(userCancellationReason());

    expect(subagentController.signal.aborted).toBe(false);
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'running',
      detached: true,
    });
  });

  it('does not count foreground tasks against the detached task limit', () => {
    const { manager } = createAgentTaskService({ maxRunningTasks: 1 });
    manager.registerTask(agentTask(new Promise(() => {}), 'foreground agent'), {
      detached: false,
    });

    manager.registerTask(agentTask(new Promise(() => {}), 'background agent'));

    expect(() => {
      manager.registerTask(agentTask(new Promise(() => {}), 'second background'));
    }).toThrow('Too many background tasks are already running.');
  });

  it('does not count foreground tasks detached later against the detached task limit', () => {
    const { manager } = createAgentTaskService({ maxRunningTasks: 1 });
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'foreground agent'),
      { detached: false },
    );

    manager.detach(taskId);

    manager.registerTask(agentTask(new Promise(() => {}), 'background agent'));

    expect(() => {
      manager.registerTask(agentTask(new Promise(() => {}), 'second background'));
    }).toThrow('Too many background tasks are already running.');
  });

  it('lists active tasks by default', () => {
    const { manager } = createAgentTaskService();
    registerProcess(manager, pendingProcess().proc, 'sleep 60', 'task 1');
    registerProcess(manager, pendingProcess().proc, 'sleep 60', 'task 2');

    expect(manager.list()).toHaveLength(2);
  });

  it('excludes terminal detached tasks from active listings and includes them in all-task listings', async () => {
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo done', 'done');

    await manager.wait(taskId);

    expect(manager.list(true)).toEqual([]);
    expect(manager.list(false)).toEqual([
      expect.objectContaining({
        taskId,
        kind: 'process',
        status: 'completed',
        exitCode: 0,
      }),
    ]);
  });

  it('honours the list limit parameter', () => {
    const { manager } = createAgentTaskService();
    const first = registerProcess(manager, pendingProcess().proc, 'sleep 1', 'one');
    const second = registerProcess(manager, pendingProcess().proc, 'sleep 2', 'two');

    expect(manager.list(true, 1)).toEqual([
      expect.objectContaining({ taskId: first }),
    ]);
    expect(manager.list(true, 1)).not.toEqual([
      expect.objectContaining({ taskId: second }),
    ]);
  });

  it('lists running tasks synchronously without waiting for task completion', () => {
    vi.useFakeTimers();
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess().proc, 'sleep 60', 'running list');

    const tasks = manager.list(true);

    expect(tasks).toEqual([
      expect.objectContaining({
        taskId,
        status: 'running',
        description: 'running list',
      }),
    ]);
  });

  it('rejects new tasks when maxRunningTasks is reached', () => {
    const { manager } = createAgentTaskService({ maxRunningTasks: 1 });

    registerProcess(manager, pendingProcess().proc, 'sleep 60', 'first task');

    expect(() => {
      registerProcess(manager, pendingProcess().proc, 'sleep 60', 'second task');
    }).toThrow('Too many background tasks are already running.');
    expect(() => {
      manager.registerTask(agentTask(new Promise(() => {}), 'agent task'));
    }).toThrow('Too many background tasks are already running.');
  });

  it('captures process output', async () => {
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'captured output\n'),
      'echo captured output',
      'capture test',
    );

    await waitForOutput(manager, taskId, 'captured output');

    expect(await manager.readOutput(taskId)).toContain('captured output');
  });

  it('terminates a foreground process task that exceeds the output limit', async () => {
    const { manager } = createAgentTaskService();
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, killSpy } = streamingProcess(chunks);
    let forwardedChars = 0;
    const onOutput = vi.fn((_kind: 'stdout' | 'stderr', text: string) => {
      forwardedChars += text.length;
    });

    const taskId = manager.registerTask(
      new ProcessTask(
        proc,
        'b3sum --length 18446744073709551615',
        'hash',
        onOutput,
      ),
      {
        detached: false,
        signal: new AbortController().signal,
        timeoutMs: 60_000,
      },
    );

    const info = await waitForTerminal(manager, taskId);

    expect(info).toMatchObject({ status: 'killed' });
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(forwardedChars).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('also terminates a detached process task that exceeds the output limit', async () => {
    const { manager } = createAgentTaskService();
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, killSpy } = streamingProcess(chunks);

    const taskId = manager.registerTask(new ProcessTask(proc, 'producer', 'bg'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(manager, taskId);

    expect(info).toMatchObject({ status: 'killed' });
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('stops appending persisted foreground output once the output limit trips', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-limit-fg-'));
    try {
      const { manager } = createAgentTaskService({ sessionDir });
      const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
      const { proc } = sigtermIgnoringProcess(chunks);

      const taskId = manager.registerTask(
        new ProcessTask(proc, 'runaway', 'hash', () => {}),
        {
          detached: false,
          signal: new AbortController().signal,
          timeoutMs: 60_000,
        },
      );

      const info = await waitForTerminal(manager, taskId);
      const output = await manager.getOutputSnapshot(taskId, 1);

      expect(info).toMatchObject({ status: 'killed' });
      expect(output.outputSizeBytes).toBeLessThanOrEqual(LIMIT_BYTES);
    } finally {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('stops appending persisted output once the output limit trips for a detached process task', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-limit-bg-'));
    try {
      const { manager } = createAgentTaskService({ sessionDir });
      const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
      const { proc } = sigtermIgnoringProcess(chunks);

      const taskId = manager.registerTask(
        new ProcessTask(proc, 'runaway', 'background runaway', () => {}),
        {
          detached: true,
          timeoutMs: 60_000,
        },
      );

      const info = await waitForTerminal(manager, taskId);
      const output = await manager.getOutputSnapshot(taskId, 1);

      expect(info).toMatchObject({ status: 'killed' });
      expect(info?.stopReason ?? '').toMatch(/output limit/i);
      expect(output.outputSizeBytes).toBeLessThanOrEqual(LIMIT_BYTES);
    } finally {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('does not cap a detached subagent result larger than the process output limit', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-limit-agent-'));
    try {
      const { manager } = createAgentTaskService({ sessionDir });
      const result = 'y'.repeat(20 * MiB);
      const taskId = manager.registerTask(
        agentTask(Promise.resolve({ result }), 'big subagent result'),
        { detached: true, timeoutMs: 60_000 },
      );

      const info = await waitForTerminal(manager, taskId);
      const output = await manager.getOutputSnapshot(taskId, 1);

      expect(info).toMatchObject({ status: 'completed' });
      expect(output.outputSizeBytes).toBe(Buffer.byteLength(result));
    } finally {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('fails process tasks when output capture errors after successful exit', async () => {
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(
      manager,
      processWithStdoutError(),
      'ssh example.test',
      'stream error test',
    );

    await expect(manager.wait(taskId)).resolves.toMatchObject({
      kind: 'process',
      status: 'failed',
      exitCode: 0,
      stopReason: 'stdout read failed',
    });
  });

  it('fails the process task once wait settles after an earlier stream error', async () => {
    const { manager } = createAgentTaskService();
    const { proc, failStdout, resolveWait } = processWithStdoutErrorBeforeWait();
    const taskId = registerProcess(
      manager,
      proc,
      'ssh example.test',
      'stream error before wait test',
    );

    await Promise.resolve();
    failStdout();
    await Promise.resolve();

    expect(await manager.wait(taskId, 0)).toMatchObject({
      kind: 'process',
      status: 'running',
      exitCode: null,
    });

    resolveWait(0);

    await expect(manager.wait(taskId)).resolves.toMatchObject({
      kind: 'process',
      status: 'failed',
      exitCode: 0,
      stopReason: 'stdout read failed',
    });
  });

  it('disposes process resources after a process task completes', async () => {
    const { manager } = createAgentTaskService();
    const dispose = vi.fn();
    const proc = {
      ...immediateProcess(0, 'hello'),
      dispose,
    } as unknown as IHostProcess;
    const taskId = registerProcess(manager, proc, 'echo hello', 'test echo');

    await waitForTerminal(manager, taskId);

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('transitions process status from exit code', async () => {
    const { manager } = createAgentTaskService();
    const successId = registerProcess(manager, immediateProcess(0), 'echo done', 'ok');
    const failureId = registerProcess(manager, immediateProcess(42), 'exit 42', 'fail');

    expect(await manager.wait(successId)).toMatchObject({
      kind: 'process',
      status: 'completed',
      exitCode: 0,
    });
    expect(await manager.wait(failureId)).toMatchObject({
      kind: 'process',
      status: 'failed',
      exitCode: 42,
    });
  });

  it('records failed runtime when proc.wait rejects', async () => {
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(
      manager,
      rejectedProcess(new Error('launch failed')),
      '/bogus/cmd',
      'broken launch',
    );

    const info = await manager.wait(taskId);

    expect(info).toMatchObject({
      status: 'failed',
      stopReason: 'launch failed',
    });
    expect(info?.endedAt).not.toBeNull();
  });

  it('does not finalize from a visible process exit code before wait settles', async () => {
    const { manager } = createAgentTaskService();
    const { proc, markExited } = processWithVisibleExitCodeBeforeWait(143);
    const taskId = registerProcess(manager, proc, 'sleep 60', 'external kill test');

    markExited();

    expect(manager.getTask(taskId)).toMatchObject({
      kind: 'process',
      status: 'running',
      exitCode: null,
      endedAt: null,
    });
    expect(await manager.wait(taskId, 1)).toMatchObject({
      kind: 'process',
      status: 'running',
      exitCode: null,
    });
  });

  it('stop kills a running process and records the stop reason', async () => {
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess(143);
    const taskId = registerProcess(manager, proc, 'sleep 60', 'kill test');

    const result = await manager.stop(taskId, 'user requested');

    expect(result).toMatchObject({
      status: 'killed',
      stopReason: 'user requested',
      exitCode: 143,
    });
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('includes stopReason for stopped tasks in all-task listings', async () => {
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess().proc, 'sleep 60', 'stop reason');

    await manager.stop(taskId, 'superseded by newer task');

    expect(manager.list(false)).toEqual([
      expect.objectContaining({
        taskId,
        status: 'killed',
        stopReason: 'superseded by newer task',
      }),
    ]);
  });

  it('disposes process resources after a stopped process task settles', async () => {
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess(143);
    const dispose = vi.fn();
    const disposableProc = {
      ...proc,
      dispose,
    } as unknown as IHostProcess;
    const taskId = registerProcess(manager, disposableProc, 'sleep 60', 'kill test');

    await manager.stop(taskId, 'user requested');

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('stop normalizes blank reasons', async () => {
    const { manager } = createAgentTaskService();
    const { proc, resolve } = manuallyResolvedProcess();
    const taskId = registerProcess(manager, proc, 'sleep 60', 'blank reason test');

    const stopPromise = manager.stop(taskId, '   ');
    resolve(0);
    const result = await stopPromise;

    expect(result).toMatchObject({ status: 'killed' });
    expect(result?.stopReason).toBeUndefined();
  });

  it('stop keeps graceful process shutdown classified as killed', async () => {
    const { manager } = createAgentTaskService();
    const { proc, killSpy, resolve } = manuallyResolvedProcess();
    const taskId = registerProcess(manager, proc, 'sleep 60', 'process race test');

    const stopPromise = manager.stop(taskId, 'user requested');
    resolve(0);
    const result = await stopPromise;

    expect(result).toMatchObject({
      status: 'killed',
      stopReason: 'user requested',
      exitCode: 0,
    });
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL');
  });

  function sigtermOnlyKillProcess(pid: number): {
    proc: IHostProcess;
    killSpy: ReturnType<typeof vi.fn>;
  } {
    const stdout = new PassThrough();
    let currentExitCode: number | null = null;
    let resolveWait: (code: number) => void = () => {};
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const killSpy = vi.fn(async (signal: NodeJS.Signals) => {
      if (currentExitCode !== null) return;
      if (signal !== 'SIGKILL') return;
      currentExitCode = 137;
      stdout.destroy();
      resolveWait(137);
    });
    const proc: IHostProcess = {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr: Readable.from([]),
      pid,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: () => waitPromise,
      kill: killSpy as unknown as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
    return { proc, killSpy };
  }

  it('escalates a wall-clock timeout to SIGKILL when the process ignores SIGTERM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = sigtermOnlyKillProcess(54327);
    const taskId = manager.registerTask(new ProcessTask(proc, 'runaway', 'timeout sigkill'), {
      timeoutMs: 1,
    });

    const terminal = manager.wait(taskId);
    await vi.advanceTimersByTimeAsync(1);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(5_000);
    const info = await terminal;

    expect(info?.status).toBe('timed_out');
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports timed_out when a timed-out process exits to SIGTERM within the grace window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess();
    const taskId = manager.registerTask(new ProcessTask(proc, 'sleep 60', 'timeout graceful'), {
      timeoutMs: 1,
    });

    const terminal = manager.wait(taskId);
    await vi.advanceTimersByTimeAsync(1);
    const info = await terminal;

    expect(info?.status).toBe('timed_out');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('applies the SIGTERM grace + SIGKILL escalation to a detachTimeout deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = sigtermOnlyKillProcess(54328);
    const taskId = manager.registerTask(new ProcessTask(proc, 'runaway', 'detach timeout'), {
      detached: false,
      detachTimeoutMs: 1,
    });
    manager.detach(taskId);

    const terminal = manager.wait(taskId);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    const info = await terminal;

    expect(info?.status).toBe('timed_out');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('auto-backgrounds a foreground task instead of killing it when its deadline fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess();
    const taskId = manager.registerTask(new ProcessTask(proc, 'sleep 60', 'auto background'), {
      detached: false,
      timeoutMs: 1_000,
      detachTimeoutMs: 5_000,
      autoBackgroundOnTimeout: true,
    });
    const waiting = manager.waitForForegroundRelease(taskId);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe('timeout_detached');
    expect(killSpy).not.toHaveBeenCalled();
    expect(manager.getTask(taskId)).toMatchObject({ status: 'running', detached: true });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.getTask(taskId)?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(manager.getTask(taskId)?.status).toBe('timed_out');
    expect(killSpy).toHaveBeenCalled();
  });

  it('kills a foreground task on timeout when auto-background is not enabled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager } = createAgentTaskService();
    const { proc, killSpy } = pendingProcess();
    const taskId = manager.registerTask(new ProcessTask(proc, 'sleep 60', 'plain timeout'), {
      detached: false,
      timeoutMs: 1_000,
      detachTimeoutMs: 5_000,
    });
    const waiting = manager.waitForForegroundRelease(taskId);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe('terminal');
    expect(killSpy).toHaveBeenCalled();
    expect(manager.getTask(taskId)?.status).toBe('timed_out');
  });

  it('persists graceful process shutdown as killed when stop was requested', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-stop-race-'));
    try {
      const writer = createAgentTaskService({ sessionDir }).manager;
      const { proc, resolve } = manuallyResolvedProcess();
      const taskId = registerProcess(writer, proc, 'sleep 60', 'persisted race');

      const stopPromise = writer.stop(taskId, 'user requested');
      resolve(0);
      await stopPromise;

      const reader = createAgentTaskService({ sessionDir }).manager;
      await reader.loadFromDisk();

      expect(reader.getTask(taskId)).toMatchObject({
        kind: 'process',
        status: 'killed',
        exitCode: 0,
        stopReason: 'user requested',
      });
    } finally {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('stop preserves agent completion when it wins the stop race', async () => {
    const { manager } = createAgentTaskService();
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const taskId = manager.registerTask(
      agentTask(completion, 'agent race test', { abortController: controller }),
    );

    const stopPromise = manager.stop(taskId, 'user requested');
    resolveCompletion({ result: 'finished naturally' });
    const result = await stopPromise;

    expect(result).toMatchObject({ status: 'completed' });
    expect(result?.stopReason).toBeUndefined();
    expect(await manager.readOutput(taskId)).toContain('finished naturally');
    expect(abort).toHaveBeenCalled();
  });

  it('stop preserves agent failure when a non-abort rejection wins', async () => {
    const { manager } = createAgentTaskService();
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const taskId = manager.registerTask(
      agentTask(completion, 'agent failure race test', { abortController: controller }),
    );

    const stopPromise = manager.stop(taskId, 'user requested');
    rejectCompletion(new Error('model failed'));
    const result = await stopPromise;

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'model failed',
    });
    expect(abort).toHaveBeenCalled();
  });

  it('stop marks agent task killed when abort rejection wins', async () => {
    const { manager } = createAgentTaskService();
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort').mockImplementation((reason?: unknown) => {
      AbortController.prototype.abort.call(controller, reason);
      rejectCompletion(abortError);
    });
    const taskId = manager.registerTask(
      agentTask(completion, 'agent abort test', { abortController: controller }),
    );

    const result = await manager.stop(taskId, 'user requested');

    expect(result).toMatchObject({
      status: 'killed',
      stopReason: 'user requested',
    });
    expect(abort).toHaveBeenCalled();
  });

  it('stop finalizes a never-settling agent task after the grace window', async () => {
    vi.useFakeTimers();
    const { manager } = createAgentTaskService();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'hung agent task', { abortController: controller }),
    );

    const stopPromise = manager.stop(taskId, 'user requested');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    const stopped = await stopPromise;

    expect(stopped).toMatchObject({
      status: 'killed',
      stopReason: 'user requested',
    });
    expect(abort).toHaveBeenCalled();
  });

  it('wait resolves on completion and returns the current snapshot on timeout', async () => {
    const { manager } = createAgentTaskService();
    const completedId = registerProcess(manager, immediateProcess(0), 'echo fast', 'wait test');

    expect(await manager.wait(completedId, 5_000)).toMatchObject({ status: 'completed' });

    const runningId = registerProcess(manager, pendingProcess().proc, 'sleep 60', 'timeout');
    expect(await manager.wait(runningId, 0)).toMatchObject({ status: 'running' });
  });

  it('rejects a cancelled wait without stopping the running task', async () => {
    const { ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(
      manager,
      pendingProcess().proc,
      'sleep 60',
      'cancelled wait',
    );
    const controller = new AbortController();
    const waiting = manager.wait(taskId, 60_000, controller.signal);
    const reason = userCancellationReason();

    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    expect(manager.getTask(taskId)).toMatchObject({ status: 'running' });
    await manager.stop(taskId, 'test cleanup');
    await ctx.dispose();
  });

  it('wait with a zero timeout returns the immediate snapshot before next-tick completion', async () => {
    const { manager } = createAgentTaskService();
    const proc = manuallyResolvedProcess();
    const taskId = registerProcess(
      manager,
      proc.proc,
      'sleep 0',
      'next-tick completion',
    );

    await Promise.resolve();
    setTimeout(() => {
      proc.resolve(0);
    }, 0);

    expect(await manager.wait(taskId, 0)).toMatchObject({
      status: 'running',
      exitCode: null,
    });
    await expect(manager.wait(taskId)).resolves.toMatchObject({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('clears task deadline timers when completion wins the race', async () => {
    vi.useFakeTimers();
    const { manager } = createAgentTaskService();
    const baselineTimerCount = vi.getTimerCount();
    const taskId = manager.registerTask(
      agentTask(Promise.resolve({ result: 'done' }), 'fast deadline task', {
        timeoutMs: 60_000,
      }),
    );

    await expect(manager.wait(taskId, 60_000)).resolves.toMatchObject({ status: 'completed' });
    expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimerCount);
  });

  it('returns undefined or empty output for unknown task ids', async () => {
    const { manager } = createAgentTaskService();

    expect(manager.getTask('bash-nonexist')).toBeUndefined();
    expect(await manager.readOutput('bash-nonexist')).toBe('');
    expect(await manager.stop('bash-nonexist')).toBeUndefined();
  });

  it('stop returns terminal info for an already-exited task', async () => {
    const { manager } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo done', 'already done');

    await manager.wait(taskId);

    expect(await manager.stop(taskId, 'too late')).toMatchObject({
      status: 'completed',
      stopReason: undefined,
    });
  });

  it('getTask on an unknown id does not create persisted state', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-mgr-missing-'));
    try {
      const { ctx, manager, persistence } = createAgentTaskService({ sessionDir });

      expect(manager.getTask('bash-bogusss0')).toBeUndefined();

      expect(await persistence!.listTasks()).toEqual([]);
      await ctx.get(ISessionMetadata).ready;
    } finally {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('launches a real process and waits to completion', async () => {
    const { spawn } = await import('node:child_process');
    const { manager } = createAgentTaskService();
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('bg-ok\\n')"],
      { stdio: 'pipe' },
    );
    const proc: IHostProcess = {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid ?? 0,
      get exitCode(): number | null {
        return child.exitCode;
      },
      wait: () =>
        new Promise<number>((resolve) => {
          child.on('exit', (code) => {
            resolve(code ?? 0);
          });
      }),
      kill: vi.fn(async (signal?: NodeJS.Signals) => {
        child.kill(signal ?? 'SIGTERM');
      }) as unknown as IHostProcess['kill'],
      dispose: vi.fn(async () => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }) as IHostProcess['dispose'],
    };

    const taskId = registerProcess(manager, proc, 'node -e <stdout bg-ok>', 'real worker');
    const info = await manager.wait(taskId, 10_000);

    expect(info).toMatchObject({ kind: 'process', status: 'completed', exitCode: 0 });
    expect(await manager.readOutput(taskId)).toContain('bg-ok');
  }, 15_000);
});

function eventStream(): {
  stream: TaskEventStream;
  batches: TaskEventBatch[];
  settle: (index: number) => void;
  overflow: ReturnType<typeof vi.fn>;
} {
  const batches: TaskEventBatch[] = [];
  const settlers: Array<() => void> = [];
  const overflow = vi.fn();
  const stream = new TaskEventStream({
    deliver: (batch, settled) => {
      batches.push(batch);
      settlers.push(settled);
    },
    overflow,
  });
  const settle = (index: number): void => {
    settlers[index]!();
  };
  return { stream, batches, settle, overflow };
}

describe('TaskEventStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits chunks into lines and batches the lines of one window into one delivery', () => {
    vi.useFakeTimers();
    const { stream, batches } = eventStream();

    stream.append('first li');
    stream.append('ne\r\n\n   \nsecond line\nthi');
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);
    expect(batches).toEqual([{ seq: 1, lines: ['first line', 'second line'], omitted: 0 }]);
  });

  it('holds new lines while a batch is undelivered and sends them after it settles', () => {
    vi.useFakeTimers();
    const { stream, batches, settle } = eventStream();

    stream.append('one\n');
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);
    stream.append('two\nthree\n');
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS * 5);
    expect(stream.hasQueuedBatch).toBe(true);
    expect(batches).toHaveLength(1);

    settle(0);
    expect(stream.hasQueuedBatch).toBe(false);
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);
    expect(batches[1]).toEqual({ seq: 2, lines: ['two', 'three'], omitted: 0 });
  });

  it('flushes the unterminated last line on close even while a batch is undelivered', () => {
    vi.useFakeTimers();
    const { stream, batches } = eventStream();

    stream.append('one\n');
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);
    stream.append('two\npartial');
    stream.close();

    expect(batches.map((batch) => batch.lines)).toEqual([['one'], ['two', 'partial']]);
    stream.append('late\n');
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);
    expect(batches).toHaveLength(2);
  });

  it('keeps the newest lines of a large batch and cuts very long lines', () => {
    vi.useFakeTimers();
    const { stream, batches } = eventStream();

    const lines = Array.from({ length: TASK_EVENT_MAX_BATCH_LINES + 3 }, (_, i) => `line ${String(i)}`);
    stream.append(`${lines.join('\n')}\n${'x'.repeat(TASK_EVENT_MAX_LINE_CHARS + 10)}\n`);
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);

    const [batch] = batches;
    expect(batch!.lines).toHaveLength(TASK_EVENT_MAX_BATCH_LINES);
    expect(batch!.omitted).toBe(4);
    expect(batch!.lines.at(-1)).toBe(`${'x'.repeat(TASK_EVENT_MAX_LINE_CHARS)}…`);
  });

  it('drops the rest of an overlong line that arrives in later chunks', () => {
    vi.useFakeTimers();
    const { stream, batches } = eventStream();

    stream.append('x'.repeat(TASK_EVENT_MAX_LINE_CHARS + 1));
    stream.append('x'.repeat(TASK_EVENT_MAX_LINE_CHARS * 3));
    stream.append('xxx\nnext line\n');
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);

    expect(batches.map((batch) => batch.lines.length)).toEqual([2]);
    expect(batches[0]!.lines[1]).toBe('next line');
  });

  it('delivers what it has and reports an overflow once the per-minute line limit is passed', () => {
    vi.useFakeTimers();
    const { stream, batches, overflow } = eventStream();

    const lines = Array.from({ length: TASK_EVENT_MAX_LINES_PER_WINDOW + 5 }, (_, i) => `l${String(i)}`);
    stream.append(`${lines.join('\n')}\n`);

    expect(overflow).toHaveBeenCalledTimes(1);
    expect(batches).toHaveLength(1);
    stream.append('after\n');
    vi.advanceTimersByTime(TASK_EVENT_BATCH_MS);
    expect(batches).toHaveLength(1);
  });
});

function controllableProcess(): {
  proc: IHostProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  exit: (exitCode: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let currentExitCode: number | null = null;
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const exit = (exitCode: number): void => {
    if (currentExitCode !== null) return;
    currentExitCode = exitCode;
    stdout.end();
    stderr.end();
    resolveWait(exitCode);
  };
  return {
    proc: {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4242,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: () => waitPromise,
      kill: vi.fn(async () => {
        exit(143);
      }) as unknown as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    },
    stdout,
    stderr,
    exit,
  };
}

function captureNotifications(fixture: TaskServiceFixture): Array<LoopNotify & { consume: () => void }> {
  const notes: Array<LoopNotify & { consume: () => void }> = [];
  vi.spyOn(fixture.ctx.get(IAgentLoopService), 'notify').mockImplementation((note: LoopNotify = {}) => {
    notes.push({ ...note, consume: () => note.onConsume?.() });
    const handle: LoopNotifyHandle = { dropped: false, drop: () => note.onDrop?.() };
    return handle;
  });
  return notes;
}

function noteText(note: LoopNotify): string {
  return (note.message?.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('AgentTaskService monitor events', () => {
  it('delivers stdout lines of a monitor task as running-task notifications', async () => {
    const fixture = createAgentTaskService();
    const notes = captureNotifications(fixture);
    const { manager } = fixture;
    const { proc, stdout, stderr, exit } = controllableProcess();
    const queued: string[] = [];
    manager.onDidQueueEvent((taskId) => queued.push(taskId));

    const taskId = manager.registerTask(new MonitorProcessTask(proc, 'tail -F app.log', 'watch app log'));
    expect(taskId).toMatch(/^monitor-[0-9a-z]{8}$/);

    stdout.write('server listening on :3000 &lt;ok&gt; <b>\n');
    stderr.write('stderr noise\n');
    await vi.waitFor(() => {
      expect(notes).toHaveLength(1);
    }, { timeout: TASK_EVENT_BATCH_MS * 3 });

    const [event] = notes;
    expect(event!.turnScoped).toBe(false);
    expect(event!.message?.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'running',
      notificationId: `task:${taskId}:event:1`,
    });
    expect(noteText(event!)).toContain('type="task.event"');
    expect(noteText(event!)).toContain('server listening on :3000 &amp;lt;ok&amp;gt; &lt;b&gt;');
    expect(noteText(event!)).not.toContain('stderr noise');
    expect(queued).toEqual([taskId]);
    expect(manager.hasQueuedEvent(taskId)).toBe(true);

    event!.consume();
    expect(manager.hasQueuedEvent(taskId)).toBe(false);
    await vi.waitFor(() => {
      expect(fixture.ctx.allEvents.filter((e) => e.event === 'background.task.event')).toHaveLength(1);
    });
    expect(fixture.ctx.allEvents.find((e) => e.event === 'background.task.event')?.args).toMatchObject({
      taskId,
      description: 'watch app log',
      lines: ['server listening on :3000 &lt;ok&gt; <b>'],
      omitted: 0,
    });

    stdout.write('last words without newline');
    exit(0);
    await waitForTerminal(manager, taskId);
    await vi.waitFor(() => {
      expect(notes.length).toBeGreaterThanOrEqual(3);
    });
    expect(noteText(notes[1]!)).toContain('last words without newline');
    expect(noteText(notes[2]!)).toContain('type="task.completed"');
    await fixture.ctx.dispose();
  });

  it('does not turn stdout of an ordinary background command into events', async () => {
    const fixture = createAgentTaskService();
    const notes = captureNotifications(fixture);
    const { proc, stdout, exit } = controllableProcess();

    const taskId = fixture.manager.registerTask(new ProcessTask(proc, 'make', 'build'));
    stdout.write('compiling\n');
    exit(0);
    await waitForTerminal(fixture.manager, taskId);
    await vi.waitFor(() => {
      expect(notes).toHaveLength(1);
    });
    expect(noteText(notes[0]!)).toContain('type="task.completed"');
    await fixture.ctx.dispose();
  });

  it('stops a monitor that prints more lines per minute than the limit', async () => {
    const fixture = createAgentTaskService();
    captureNotifications(fixture);
    const { proc, stdout } = controllableProcess();

    const taskId = fixture.manager.registerTask(new MonitorProcessTask(proc, 'yes', 'noisy'));
    const lines = Array.from({ length: TASK_EVENT_MAX_LINES_PER_WINDOW + 1 }, () => 'y');
    stdout.write(`${lines.join('\n')}\n`);

    const info = await waitForTerminal(fixture.manager, taskId);
    expect(info).toMatchObject({ status: 'killed' });
    expect(info?.stopReason).toContain('Event limit exceeded');
    await fixture.ctx.dispose();
  });
});
