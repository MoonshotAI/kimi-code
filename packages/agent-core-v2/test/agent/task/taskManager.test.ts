import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { AgentTaskService } from '#/agent/task/taskService';
import { userCancellationReason } from '#/_base/utils/abort';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import type { AgentRunHandle } from '#/session/subagent/subagent';
import {
  configServices,
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  createTaskChannel,
  startAgentTask,
  startBashTask,
  startControlledTask,
  taskHistoryRecords as recordsFor,
  type ControlledTask,
  type ControlledTaskOptions,
  type TaskChannel,
} from './stubs';

const MiB = 1024 * 1024;

interface TaskServiceFixture {
  readonly channel: TaskChannel;
  readonly manager: IAgentTaskService;
  readonly persistence?: ReturnType<typeof createAgentTaskPersistence>;
}

function createAgentTaskService(options: { sessionDir?: string } = {}): TaskServiceFixture {
  const persistence = options.sessionDir === undefined
    ? undefined
    : createAgentTaskPersistence(options.sessionDir);
  const channel = createTaskChannel({ persistence });
  return { channel, manager: channel.service, persistence };
}

async function controlled(fixture: TaskServiceFixture, options: ControlledTaskOptions = {}): Promise<ControlledTask> {
  return startControlledTask(fixture.channel, options);
}

async function waitForTerminal(
  manager: IAgentTaskService,
  taskId: string,
  timeoutMs = 30_000,
): Promise<AgentTaskInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const info = await manager.wait(taskId, 5);
    if (info !== undefined && info.status !== 'running') return info;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return manager.getTask(taskId);
}

async function waitForOutput(manager: IAgentTaskService, taskId: string, expected: string): Promise<void> {
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

function pendingProcess(exitOnKill = 143): {
  proc: IHostProcess;
  killSpy: ReturnType<typeof vi.fn>;
  resolve: (exitCode: number) => void;
} {
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode !== null) return;
    currentExitCode = exitOnKill;
    resolveWait(currentExitCode);
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode() {
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

function sigtermIgnoringProcess(): {
  proc: IHostProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async (signal: NodeJS.Signals) => {
    if (signal !== 'SIGKILL' || currentExitCode !== null) return;
    currentExitCode = 137;
    resolveWait(currentExitCode);
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54326,
    get exitCode() {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return { proc, killSpy };
}

function processContext(
  proc: IHostProcess,
  task?: { bashTaskTimeoutS?: number; killGracePeriodMs?: number; bashAutoBackgroundOnTimeout?: boolean },
): TestAgentContext {
  return createTestAgent(
    execEnvServices({ processRunner: { spawn: async () => proc } }),
    configServices(() => ({ providers: {}, task: task ?? {} })),
  );
}

function agentContext(
  completion: Promise<{ readonly summary: string }>,
  partialOutput = '',
): TestAgentContext {
  const ctx = createTestAgent();
  vi.spyOn(ctx.get(ISessionSubagentService), 'run').mockImplementation(async (agent) => ({
    agentId: agent.agentId,
    turn: {} as AgentRunHandle['turn'],
    completion,
    partialOutput: () => partialOutput,
  }));
  return ctx;
}

describe('AgentTaskService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers process tasks and exposes process metadata', async () => {
    const ctx = processContext(immediateProcess(0));
    try {
      const handler = startBashTask(ctx, { command: 'echo hello', description: 'test echo', run_in_background: true });
      await handler.wait();
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)).toMatchObject({
        kind: 'process', command: 'echo hello', description: 'test echo', pid: 10000, status: 'completed', exitCode: 0,
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('registers agent tasks and exposes agent metadata', async () => {
    const ctx = agentContext(Promise.resolve({ summary: 'done' }));
    try {
      const handler = startAgentTask(ctx, { description: 'agent work', prompt: 'agent work', run_in_background: true });
      await handler.wait();
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)).toMatchObject({
        kind: 'agent', description: 'agent work', status: 'completed', resultSummary: undefined,
      });
      expect(handler.taskId).toMatch(/^agent-/);
    } finally {
      await ctx.dispose();
    }
  });

  it('keeps waiting for real completion after a foreground task detaches', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    fixture.manager.detach(task.handler.taskId);
    let settled = false;
    const waiting = fixture.manager.wait(task.handler.taskId);
    void waiting.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    task.resolve('done');
    expect((await waiting)?.status).toBe('completed');
  });

  it('settles foreground waiters when a foreground task completes', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false, completion: Promise.resolve('done') });
    expect((await fixture.manager.wait(task.handler.taskId))?.status).toBe('completed');
  });

  it('stops foreground tasks through their handler', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    await fixture.manager.stop(task.handler.taskId, userCancellationReason().message);
    expect((await fixture.manager.wait(task.handler.taskId))?.status).toBe('killed');
  });

  it('keeps a detached process task running when a wait times out', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    fixture.manager.detach(task.handler.taskId);
    expect((await fixture.manager.wait(task.handler.taskId, 0))?.status).toBe('running');
    task.resolve('');
  });

  it('forwards foreground stop reasons to agent task controllers', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    const reason = userCancellationReason();
    await task.handler.stop(reason);
    await fixture.manager.wait(task.handler.taskId);
    expect(task.handler.snapshot().stopReason).toBe(reason.message);
  });

  it('does not stop a detached agent task when a wait is cancelled', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    fixture.manager.detach(task.handler.taskId);
    const controller = new AbortController();
    const waiting = fixture.manager.wait(task.handler.taskId, undefined, controller.signal);
    controller.abort(userCancellationReason());
    await expect(waiting).rejects.toThrow();
    expect(task.handler.snapshot().stopReason).toBeUndefined();
    task.resolve('');
  });

  it('allows multiple foreground tasks without a detached task limit', async () => {
    const fixture = createAgentTaskService();
    await controlled(fixture, { detached: false });
    await controlled(fixture, { detached: false });
    expect(fixture.manager.list(true)).toHaveLength(2);
  });

  it('allows multiple foreground tasks detached later without a task limit', async () => {
    const fixture = createAgentTaskService();
    const first = await controlled(fixture, { detached: false });
    const second = await controlled(fixture, { detached: false });
    fixture.manager.detach(first.handler.taskId);
    fixture.manager.detach(second.handler.taskId);
    expect(fixture.manager.list(true)).toHaveLength(2);
  });

  it('keeps a foreground task queryable and detaches it on request', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    expect(fixture.manager.getTask(task.handler.taskId)?.detached).toBe(false);
    expect(fixture.manager.detach(task.handler.taskId)?.detached).toBe(true);
    task.resolve('');
  });

  it('lists active tasks by default', async () => {
    const fixture = createAgentTaskService();
    await controlled(fixture);
    expect(fixture.manager.list().every((task) => task.status === 'running')).toBe(true);
  });

  it('excludes terminal detached tasks from active listings and includes them in all-task listings', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { completion: Promise.resolve('done') });
    await fixture.manager.wait(task.handler.taskId);
    expect(fixture.manager.list(true)).toEqual([]);
    expect(fixture.manager.list(false).map((info) => info.taskId)).toContain(task.handler.taskId);
  });

  it('honours the list limit parameter', async () => {
    const fixture = createAgentTaskService();
    await controlled(fixture);
    await controlled(fixture);
    expect(fixture.manager.list(false, 1)).toHaveLength(1);
  });

  it('lists running tasks synchronously without waiting for task completion', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture);
    expect(fixture.manager.list(true)[0]?.taskId).toBe(task.handler.taskId);
  });

  it('allows concurrent background tasks instead of rejecting at a capacity', async () => {
    const fixture = createAgentTaskService();
    await controlled(fixture);
    await controlled(fixture);
    await controlled(fixture);
    expect(fixture.manager.list(true)).toHaveLength(3);
  });

  it('captures process output', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'hello\n', completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    expect(await fixture.manager.readOutput(task.handler.taskId)).toBe('hello\n');
  });

  it('retains a tail in memory when foreground output exceeds the buffer', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false, output: 'a'.repeat(MiB + 100), completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    expect(task.handler.output().truncated).toBe(true);
    expect(task.handler.output().totalBytes).toBe(MiB + 100);
  });

  it('retains a tail in memory when detached output exceeds the buffer', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'b'.repeat(MiB + 100), completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    expect(task.handler.output().truncated).toBe(true);
    expect(task.handler.output().totalBytes).toBe(MiB + 100);
  });

  it('persists complete output after the in-memory retention limit trips', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'c'.repeat(MiB + 100), completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    expect((await fixture.manager.getOutputSnapshot(task.handler.taskId, 100)).outputSizeBytes).toBe(MiB + 100);
  });

  it('publishes handler changes on creation, detach and terminal completion', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { detached: false });
    const statuses: string[] = [];
    const unobserve = task.handler.observe((event) => {
      if (event.type === 'change') statuses.push(event.snapshot.status);
    });
    fixture.manager.detach(task.handler.taskId);
    task.resolve('');
    await fixture.manager.wait(task.handler.taskId);
    unobserve();
    expect(statuses).toContain('running');
    expect(statuses.at(-1)).toBe('success');
  });

  it('publishes output events while the snapshot retains only the tail', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'a'.repeat(MiB + 100), completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    expect(task.handler.output().preview.length).toBeLessThanOrEqual(MiB);
    expect(task.handler.output().totalBytes).toBe(MiB + 100);
  });

  it('keeps full detached output readable after the retention limit trips', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'd'.repeat(MiB + 100), completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    const tail = await fixture.manager.readOutputTail(task.handler.taskId, 100);
    expect(tail.data.byteLength).toBe(100);
  });

  it('does not cap a detached agent result at the process retention limit', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'e'.repeat(MiB + 100), completion: Promise.resolve('') });
    await fixture.manager.wait(task.handler.taskId);
    expect(task.handler.output().totalBytes).toBe(MiB + 100);
  });

  it('fails a task when its completion rejects after successful output', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { output: 'partial', completion: Promise.reject(new Error('capture failed')) });
    expect((await fixture.manager.wait(task.handler.taskId))?.status).toBe('failed');
    expect(await fixture.manager.readOutput(task.handler.taskId)).toContain('partial');
  });

  it('fails the task once wait settles after an earlier stream error', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { completion: Promise.reject(new Error('stream failed')) });
    expect((await fixture.manager.wait(task.handler.taskId))?.stopReason).toContain('stream failed');
  });

  it('disposes process resources after a process task completes', async () => {
    const proc = immediateProcess(0);
    const ctx = processContext(proc);
    try {
      const handler = startBashTask(ctx, { command: 'echo', description: 'demo', run_in_background: true });
      await handler.wait();
      expect(proc.dispose).toHaveBeenCalledOnce();
    } finally {
      await ctx.dispose();
    }
  });

  it('transitions process status from exit code', async () => {
    for (const [exitCode, status] of [[0, 'completed'], [2, 'failed']] as const) {
      const ctx = processContext(immediateProcess(exitCode));
      try {
        const handler = startBashTask(ctx, { command: 'exit', description: 'demo', run_in_background: true });
        expect((await ctx.get(IAgentTaskService).wait(handler.taskId))?.status).toBe(status);
      } finally {
        await ctx.dispose();
      }
    }
  });

  it('records failed environment when proc.wait rejects', async () => {
    const ctx = processContext(rejectedProcess(new Error('wait failed')));
    try {
      const handler = startBashTask(ctx, { command: 'wait', description: 'demo', run_in_background: true });
      expect((await ctx.get(IAgentTaskService).wait(handler.taskId))?.status).toBe('failed');
    } finally {
      await ctx.dispose();
    }
  });

  it('does not finalize from a visible process exit code before wait settles', async () => {
    const pending = pendingProcess(0);
    const ctx = processContext(pending.proc);
    try {
      const handler = startBashTask(ctx, { command: 'wait', description: 'demo', run_in_background: true });
      await handler;
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)?.status).toBe('running');
      pending.resolve(0);
      expect((await ctx.get(IAgentTaskService).wait(handler.taskId))?.status).toBe('completed');
    } finally {
      await ctx.dispose();
    }
  });

  it('stop kills a running process and records the stop reason', async () => {
    const pending = pendingProcess();
    const ctx = processContext(pending.proc);
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: true });
      await handler;
      const info = await ctx.get(IAgentTaskService).stop(handler.taskId, 'stop now');
      expect(info).toMatchObject({ status: 'killed', stopReason: 'stop now' });
      expect(pending.killSpy).toHaveBeenCalled();
    } finally {
      await ctx.dispose();
    }
  });

  it('includes stopReason for stopped tasks in all-task listings', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture);
    await fixture.manager.stop(task.handler.taskId, 'stop now');
    expect(fixture.manager.list(false)[0]?.stopReason).toBe('stop now');
  });

  it('disposes process resources after a stopped process task settles', async () => {
    const pending = pendingProcess();
    const ctx = processContext(pending.proc);
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: true });
      await handler;
      await ctx.get(IAgentTaskService).stop(handler.taskId);
      expect(pending.proc.dispose).toHaveBeenCalledOnce();
    } finally {
      await ctx.dispose();
    }
  });

  it('stop normalizes blank reasons', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture);
    await fixture.manager.stop(task.handler.taskId, '   ');
    expect(fixture.manager.getTask(task.handler.taskId)?.stopReason).not.toBe('   ');
  });

  it('stop keeps graceful process shutdown classified as killed', async () => {
    const pending = pendingProcess(143);
    const ctx = processContext(pending.proc);
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: true });
      await handler;
      expect((await ctx.get(IAgentTaskService).stop(handler.taskId))?.status).toBe('killed');
    } finally {
      await ctx.dispose();
    }
  });

  it('escalates a wall-clock timeout to SIGKILL when the process ignores SIGTERM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = sigtermIgnoringProcess();
    const ctx = processContext(pending.proc, { killGracePeriodMs: 10 });
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: true, timeout: 1 });
      await handler;
      const terminal = handler.wait();
      await vi.advanceTimersByTimeAsync(1_500);
      await terminal;
      expect(pending.killSpy).toHaveBeenCalledWith('SIGKILL');
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)?.status).toBe('timed_out');
    } finally {
      await ctx.dispose();
    }
  });

  it('reports timed_out when a timed-out process exits to SIGTERM within the grace window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = pendingProcess(143);
    const ctx = processContext(pending.proc, { killGracePeriodMs: 100 });
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: true, timeout: 1 });
      await handler;
      const terminal = handler.wait();
      await vi.advanceTimersByTimeAsync(1_250);
      await terminal;
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)?.status).toBe('timed_out');
    } finally {
      await ctx.dispose();
    }
  });

  it('applies the SIGTERM grace + SIGKILL escalation to a detachTimeout deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = sigtermIgnoringProcess();
    const ctx = processContext(pending.proc, { bashTaskTimeoutS: 1, killGracePeriodMs: 10 });
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: false });
      await vi.waitFor(() => expect(handler.snapshot().fields['task']).toBeDefined());
      handler.detach();
      const terminal = handler.wait();
      await vi.advanceTimersByTimeAsync(1_500);
      await terminal;
      expect(pending.killSpy).toHaveBeenCalledWith('SIGKILL');
    } finally {
      await ctx.dispose();
    }
  });

  it('auto-backgrounds a foreground task instead of killing it when its deadline fires', async () => {
    const pending = pendingProcess();
    const ctx = processContext(pending.proc);
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: false, timeout: 1 });
      expect(await handler).toMatchObject({ detached: true });
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)?.status).toBe('running');
      await ctx.get(IAgentTaskService).stop(handler.taskId);
    } finally {
      await ctx.dispose();
    }
  });

  it('kills a foreground task on timeout when auto-background is not enabled', async () => {
    const pending = pendingProcess();
    const ctx = processContext(pending.proc, { bashAutoBackgroundOnTimeout: false });
    try {
      const handler = startBashTask(ctx, { command: 'sleep', description: 'demo', run_in_background: false, timeout: 1 });
      await handler.wait();
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)?.status).toBe('timed_out');
    } finally {
      await ctx.dispose();
    }
  });

  it('does not restore graceful process shutdown from task metadata', () => {
    const service = new AgentTaskService('main');
    const info: AgentTaskInfo = {
      taskId: 'bash-deadbeef', kind: 'process', description: 'stopped', command: 'sleep', pid: 1,
      status: 'killed', stopCode: 'SIGTERM', exitCode: 143, startedAt: 0, endedAt: 1,
    };
    service.restore(recordsFor([info]));
    expect(service.get(info.taskId)).toMatchObject({ status: 'killed', stopCode: 'SIGTERM' });
  });

  it('stop preserves agent completion when it wins the stop race', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { completion: Promise.resolve('done') });
    await fixture.manager.wait(task.handler.taskId);
    expect((await fixture.manager.stop(task.handler.taskId))?.status).toBe('completed');
  });

  it('stop preserves agent failure when a non-abort rejection wins', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { completion: Promise.reject(new Error('failed first')) });
    await fixture.manager.wait(task.handler.taskId);
    expect((await fixture.manager.stop(task.handler.taskId))?.status).toBe('failed');
  });

  it('stop marks agent task killed when abort rejection wins', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture);
    expect((await fixture.manager.stop(task.handler.taskId))?.status).toBe('killed');
  });

  it('stop finalizes a never-settling agent task after the grace window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctx = agentContext(new Promise(() => {}), 'partial output');
    try {
      const handler = startAgentTask(ctx, { description: 'hung', prompt: 'hung', run_in_background: true });
      await handler;
      const stopped = handler.stop('stop now');
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;
      expect(ctx.get(IAgentTaskService).getTask(handler.taskId)?.status).toBe('killed');
      expect(handler.output().preview).toContain('partial output');
    } finally {
      await ctx.dispose();
    }
  });

  it('wait resolves on completion and returns the current snapshot on timeout', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture);
    expect((await fixture.manager.wait(task.handler.taskId, 0))?.status).toBe('running');
    task.resolve('done');
    expect((await fixture.manager.wait(task.handler.taskId))?.status).toBe('completed');
  });

  it('rejects a cancelled wait without stopping the running task', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture);
    const controller = new AbortController();
    const waiting = fixture.manager.wait(task.handler.taskId, undefined, controller.signal);
    controller.abort(userCancellationReason());
    await expect(waiting).rejects.toThrow();
    expect(fixture.manager.getTask(task.handler.taskId)?.status).toBe('running');
    task.resolve('');
  });

  it('wait with a zero timeout returns the immediate snapshot before task completion', async () => {
    const fixture = createAgentTaskService();
    // Delay completion beyond the microtask queue so the zero-timeout snapshot
    // cannot race Promise.resolve() scheduling in different test runners.
    const completion = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 10);
    });
    const task = await controlled(fixture, { completion });
    expect((await fixture.manager.wait(task.handler.taskId, 0))?.status).toBe('running');
    expect((await fixture.manager.wait(task.handler.taskId))?.status).toBe('completed');
  });

  it('clears task deadline timers when completion wins the race', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { timeoutMs: 1_000, completion: Promise.resolve('done') });
    await fixture.manager.wait(task.handler.taskId);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.manager.getTask(task.handler.taskId)?.status).toBe('completed');
  });

  it('returns undefined or empty output for unknown task ids', async () => {
    const fixture = createAgentTaskService();
    expect(fixture.manager.getTask('bash-deadbeef')).toBeUndefined();
    expect(await fixture.manager.readOutput('bash-deadbeef')).toBe('');
  });

  it('stop returns terminal info for an already-exited task', async () => {
    const fixture = createAgentTaskService();
    const task = await controlled(fixture, { completion: Promise.resolve('done') });
    await fixture.manager.wait(task.handler.taskId);
    expect((await fixture.manager.stop(task.handler.taskId))?.status).toBe('completed');
  });

  it('getTask on an unknown id does not create persisted state', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'task-unknown-'));
    try {
      const fixture = createAgentTaskService({ sessionDir });
      expect(fixture.manager.getTask('bash-deadbeef')).toBeUndefined();
      expect(await fixture.persistence!.taskOutputExists('bash-deadbeef')).toBe(false);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('launches a real process and waits to completion', async () => {
    const ctx = processContext(immediateProcess(0, 'real output\n'));
    try {
      const handler = startBashTask(ctx, { command: 'echo real', description: 'real process', run_in_background: true });
      expect((await ctx.get(IAgentTaskService).wait(handler.taskId))?.status).toBe('completed');
      expect(await ctx.get(IAgentTaskService).readOutput(handler.taskId)).toBe('real output\n');
    } finally {
      await ctx.dispose();
    }
  });
});
