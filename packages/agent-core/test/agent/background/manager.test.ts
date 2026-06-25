/**
 * Covers: BackgroundManager.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTaskPersistence,
  ProcessBackgroundTask,
  type BackgroundManager,
} from '../../../src/agent/background';
import {
  agentTask,
  createBackgroundManager,
  registerProcess,
  waitForOutput,
  waitForTerminal,
} from './helpers';
import { isUserCancellation, userCancellationReason } from '../../../src/utils/abort';

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function rejectedProcess(error: Error): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 99999,
    exitCode: null,
    wait: vi.fn().mockRejectedValue(error) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function processWithStdoutError(message = 'stdout read failed'): KaosProcess {
  const stdout = new PassThrough();
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: Readable.from([]),
    pid: 99998,
    exitCode: 0,
    wait: vi.fn(async () => {
      stdout.destroy(new Error(message));
      return 0;
    }) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

function processWithStdoutErrorBeforeWait(message = 'stdout read failed'): {
  proc: KaosProcess;
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
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr: Readable.from([]),
      pid: 99997,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: vi.fn(() => waitPromise) as KaosProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
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
  proc: KaosProcess;
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
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
  return { proc, killSpy };
}

function manuallyResolvedProcess(): {
  proc: KaosProcess;
  killSpy: ReturnType<typeof vi.fn>;
  resolve: (exitCode: number) => void;
} {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn().mockResolvedValue(undefined);
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54324,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
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
  proc: KaosProcess;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54322,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => new Promise<number>(() => {}),
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
  return {
    proc,
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

describe('BackgroundManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers process tasks and exposes process metadata', () => {
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();

    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'investigate bug', {
        agentId: 'agent-child',
        subagentType: 'coder',
      }),
    );

    expect(taskId).toMatch(/^agent-[0-9a-z]{8}$/);
    expect(manager.getTask(taskId)).toMatchObject({
      taskId,
      kind: 'agent',
      description: 'investigate bug',
      agentId: 'agent-child',
      subagentType: 'coder',
      status: 'running',
    });
  });

  it('tracks foreground tasks and releases their waiter when detached', async () => {
    const { manager } = createBackgroundManager();
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
    const { agent, manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(Promise.resolve({ result: 'done' }), 'foreground agent'),
      { detached: false },
    );

    await expect(manager.waitForForegroundRelease(taskId)).resolves.toBe('terminal');
    expect(manager.getTask(taskId)).toMatchObject({
      detached: false,
      status: 'completed',
    });
    expect(agent.turn.steer).not.toHaveBeenCalled();
  });

  it('stops foreground tasks from their register-time signal', async () => {
    const { manager } = createBackgroundManager();
    const { proc, killSpy } = pendingProcess();
    const controller = new AbortController();
    const taskId = manager.registerTask(
      new ProcessBackgroundTask(proc, 'sleep 10', 'foreground process'),
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
      stopReason: 'Interrupted by user',
    });
  });

  it('forwards foreground signal abort reasons to agent task controllers', async () => {
    const { manager } = createBackgroundManager();
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
      stopReason: 'Interrupted by user',
    });
    expect(isUserCancellation(subagentController.signal.reason)).toBe(true);
  });

  it('does not count foreground tasks against the detached task limit', () => {
    const { manager } = createBackgroundManager({ maxRunningTasks: 1 });
    manager.registerTask(agentTask(new Promise(() => {}), 'foreground agent'), {
      detached: false,
    });

    manager.registerTask(agentTask(new Promise(() => {}), 'background agent'));

    expect(() => {
      manager.registerTask(agentTask(new Promise(() => {}), 'second background'));
    }).toThrow('Too many background tasks are already running.');
  });

  it('does not count foreground tasks detached later against the background task limit', () => {
    const { manager } = createBackgroundManager({ maxRunningTasks: 1 });
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
    const { manager } = createBackgroundManager();
    registerProcess(manager, pendingProcess().proc, 'sleep 60', 'task 1');
    registerProcess(manager, pendingProcess().proc, 'sleep 60', 'task 2');

    expect(manager.list()).toHaveLength(2);
  });

  it('rejects new tasks when maxRunningTasks is reached', () => {
    const { manager } = createBackgroundManager({ maxRunningTasks: 1 });

    registerProcess(manager, pendingProcess().proc, 'sleep 60', 'first task');

    expect(() => {
      registerProcess(manager, pendingProcess().proc, 'sleep 60', 'second task');
    }).toThrow('Too many background tasks are already running.');
    expect(() => {
      manager.registerTask(agentTask(new Promise(() => {}), 'agent task'));
    }).toThrow('Too many background tasks are already running.');
  });

  it('captures process output', async () => {
    const { manager } = createBackgroundManager();
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'captured output\n'),
      'echo captured output',
      'capture test',
    );

    await waitForOutput(manager, taskId, 'captured output');

    expect(await manager.readOutput(taskId)).toContain('captured output');
  });

  it('fails process tasks when output capture errors after successful exit', async () => {
    const { manager } = createBackgroundManager();
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

  it('handles process stream errors before process wait settles', async () => {
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
    const dispose = vi.fn();
    const proc = {
      ...immediateProcess(0, 'hello'),
      dispose,
    } as unknown as KaosProcess;
    const taskId = registerProcess(manager, proc, 'echo hello', 'test echo');

    await waitForTerminal(manager, taskId);

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('transitions process status from exit code', async () => {
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
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

  it('disposes process resources after a stopped process task settles', async () => {
    const { manager } = createBackgroundManager();
    const { proc, killSpy } = pendingProcess(143);
    const dispose = vi.fn();
    const disposableProc = {
      ...proc,
      dispose,
    } as unknown as KaosProcess;
    const taskId = registerProcess(manager, disposableProc, 'sleep 60', 'kill test');

    await manager.stop(taskId, 'user requested');

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('stop normalizes blank reasons', async () => {
    const { manager } = createBackgroundManager();
    const { proc, resolve } = manuallyResolvedProcess();
    const taskId = registerProcess(manager, proc, 'sleep 60', 'blank reason test');

    const stopPromise = manager.stop(taskId, '   ');
    resolve(0);
    const result = await stopPromise;

    expect(result).toMatchObject({ status: 'killed' });
    expect(result?.stopReason).toBeUndefined();
  });

  it('stop keeps graceful process shutdown classified as killed', async () => {
    const { manager } = createBackgroundManager();
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

  it('persists graceful process shutdown as killed when stop was requested', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-stop-race-'));
    try {
      const writer = createBackgroundManager({ sessionDir }).manager;
      const { proc, resolve } = manuallyResolvedProcess();
      const taskId = registerProcess(writer, proc, 'sleep 60', 'persisted race');

      const stopPromise = writer.stop(taskId, 'user requested');
      resolve(0);
      await stopPromise;

      const reader = createBackgroundManager({ sessionDir }).manager;
      await reader.loadFromDisk();

      expect(reader.getTask(taskId)).toMatchObject({
        kind: 'process',
        status: 'killed',
        exitCode: 0,
        stopReason: 'user requested',
      });
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('stop preserves agent completion when it wins the stop race', async () => {
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
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
    const { manager } = createBackgroundManager();
    const completedId = registerProcess(manager, immediateProcess(0), 'echo fast', 'wait test');

    expect(await manager.wait(completedId, 5_000)).toMatchObject({ status: 'completed' });

    const runningId = registerProcess(manager, pendingProcess().proc, 'sleep 60', 'timeout');
    expect(await manager.wait(runningId, 0)).toMatchObject({ status: 'running' });
  });

  it('clears task deadline timers when completion wins the race', async () => {
    vi.useFakeTimers();
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(
      agentTask(Promise.resolve({ result: 'done' }), 'fast deadline task'),
      { timeoutMs: 60_000 },
    );

    await expect(manager.wait(taskId, 60_000)).resolves.toMatchObject({ status: 'completed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the deadline to detachTimeoutMs when a foreground task is detached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { manager } = createBackgroundManager();
      const { proc } = pendingProcess();
      const taskId = manager.registerTask(new ProcessBackgroundTask(proc, 'sleep 60', 'detach timeout'), {
        detached: false,
        timeoutMs: 1_000,
        detachTimeoutMs: 5_000,
      });

      // Let the lifecycle arm its foreground timer, then detach at 500ms.
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.detach(taskId)?.detached).toBe(true);

      // Past the original 1s deadline; the task is still running because detach
      // reset the timer to 5s counted from the detach moment.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.getTask(taskId)?.status).toBe('running');

      // Past the 5s detach deadline (500 + 5000 = 5500ms).
      await vi.advanceTimersByTimeAsync(4_500);
      expect(manager.getTask(taskId)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined or empty output for unknown task ids', async () => {
    const { manager } = createBackgroundManager();

    expect(manager.getTask('bash-nonexist')).toBeUndefined();
    expect(await manager.readOutput('bash-nonexist')).toBe('');
    expect(await manager.stop('bash-nonexist')).toBeUndefined();
  });

  it('stop returns terminal info for an already-exited task', async () => {
    const { manager } = createBackgroundManager();
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
      const { manager } = createBackgroundManager({ sessionDir });

      expect(manager.getTask('bash-bogusss0')).toBeUndefined();

      expect(await new BackgroundTaskPersistence(sessionDir).listTasks()).toEqual([]);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('launches a real process and waits to completion', async () => {
    const { spawn } = await import('node:child_process');
    const { manager } = createBackgroundManager();
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('bg-ok\\n')"],
      { stdio: 'pipe' },
    );
    const proc: KaosProcess = {
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
      }) as unknown as KaosProcess['kill'],
      dispose: vi.fn(async () => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }) as KaosProcess['dispose'],
    };

    const taskId = registerProcess(manager, proc, 'node -e <stdout bg-ok>', 'real worker');
    const info = await manager.wait(taskId, 10_000);

    expect(info).toMatchObject({ kind: 'process', status: 'completed', exitCode: 0 });
    expect(await manager.readOutput(taskId)).toContain('bg-ok');
  }, 15_000);
});
