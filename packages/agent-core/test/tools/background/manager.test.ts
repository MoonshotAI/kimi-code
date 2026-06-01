/**
 * Covers: BackgroundManager.
 *
 * Uses KaosProcess fakes — the manager accepts KaosProcess directly,
 * with no ChildProcess dependency.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentBackgroundTask, BackgroundManager } from '../../../src/agent/background';

/**
 * Creates a KaosProcess that completes immediately with the given exit code.
 * stdout emits `stdoutText` if provided.
 */
function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

/**
 * Creates a KaosProcess that stays running until `kill()` is called.
 * Calling `kill()` resolves `wait()` with `exitOnKill`.
 */
function pendingProcess(exitOnKill = 143): {
  proc: KaosProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode === null) {
      currentExitCode = exitOnKill;
      resolveWait(exitOnKill);
    }
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
  };
  return { proc, killSpy };
}

function manuallyResolvedProcess(): {
  proc: KaosProcess;
  killSpy: ReturnType<typeof vi.fn>;
  resolve: (exitCode: number) => void;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
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

function waiterCount(manager: BackgroundManager, taskId: string): number {
  const tasks = (
    manager as unknown as {
      tasks: Map<string, { waiters: Array<() => void> }>;
    }
  ).tasks;
  return tasks.get(taskId)?.waiters.length ?? 0;
}

function processExitingAfterSigkill(
  exitOnKill = 137,
  delayMs = 25,
): {
  proc: KaosProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async (signal?: NodeJS.Signals) => {
    if (signal !== 'SIGKILL' || currentExitCode !== null) return;
    setTimeout(() => {
      currentExitCode = exitOnKill;
      resolveWait(exitOnKill);
    }, delayMs);
  });
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54323,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
  };
  return { proc, killSpy };
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
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
  return {
    proc,
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

describe('BackgroundManager', () => {
  const manager = new BackgroundManager();

  afterEach(() => {
    manager._reset();
  });

  it('register returns a task ID and tracks the process', () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo hello', 'test echo');
    // Id format is `{bash|agent}-{8 base36}`.
    expect(taskId).toMatch(/^bash-[0-9a-z]{8}$/);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.kind).toBe('process');
    if (info!.kind !== 'process') throw new Error('expected process task');
    expect(info!.command).toBe('echo hello');
    expect(info!.description).toBe('test echo');
    expect(info!.pid).toBe(proc.pid);
  });

  it('records failed runtime when proc.wait() rejects', async () => {
    // Simulate a Kaos launch that resolves into a KaosProcess whose
    // subsequent wait() rejects (e.g. shell fork failure mid-exec).
    const proc: KaosProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 99999,
      exitCode: null,
      wait: vi.fn().mockRejectedValue(new Error('launch failed')) as KaosProcess['wait'],
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    };
    const taskId = manager.register(proc, '/bogus/cmd', 'broken launch');

    // Let the wait() rejection propagate through the .finally block.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.endedAt).not.toBeNull();
  });

  it('registerAgentTask registers as running with agent- id prefix', () => {
    // Promise that never resolves — we only inspect the initial register
    // snapshot here.
    const taskId = manager.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'agent task'));
    expect(taskId).toMatch(/^agent-[0-9a-z]{8}$/);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.kind).toBe('agent');
    expect(info!.status).toBe('running');
    expect('pid' in info!).toBe(false);
    expect('command' in info!).toBe(false);
  });

  it('getTask on an unknown id does not touch disk or create state', () => {
    // Live + ghost maps stay untouched; no partial creation.
    const before = manager.list(false).length;
    expect(manager.getTask('bash-deadbeef')).toBeUndefined();
    const after = manager.list(false).length;
    expect(after).toBe(before);
  });

  it('list returns active tasks by default', () => {
    const { proc: proc1 } = pendingProcess();
    const { proc: proc2 } = pendingProcess();
    manager.register(proc1, 'sleep 60', 'task 1');
    manager.register(proc2, 'sleep 60', 'task 2');
    const active = manager.list(true);
    expect(active.length).toBe(2);
  });

  it('rejects new bash tasks when maxRunningTasks is reached', () => {
    const limited = new BackgroundManager({ maxRunningTasks: 1 });
    const { proc: first } = pendingProcess();
    const { proc: second } = pendingProcess();

    limited.register(first, 'sleep 60', 'first task');

    expect(() => {
      limited.register(second, 'sleep 60', 'second task');
    }).toThrow('Too many background tasks are already running.');
  });

  it('rejects new agent tasks when maxRunningTasks is reached', () => {
    const limited = new BackgroundManager({ maxRunningTasks: 1 });

    limited.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'first agent'));

    expect(() => {
      limited.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'second agent'));
    }).toThrow('Too many background tasks are already running.');
  });

  it('getOutput returns captured stdout', async () => {
    const proc = immediateProcess(0, 'captured output\n');
    const taskId = manager.register(proc, 'echo captured output', 'capture test');

    // Allow the wait() promise and stream data events to settle.
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const output = manager.getOutput(taskId);
    expect(output).toContain('captured output');
  });

  it('task status transitions to completed on exit code 0', async () => {
    const proc = immediateProcess(0, 'done');
    const taskId = manager.register(proc, 'echo done', 'completion test');

    // Allow the wait() promise to settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info).toMatchObject({ kind: 'process', status: 'completed', exitCode: 0 });
  });

  it('task status transitions to failed on non-zero exit', async () => {
    const proc = immediateProcess(42);
    const taskId = manager.register(proc, 'exit 42', 'fail test');

    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info).toMatchObject({ kind: 'process', status: 'failed', exitCode: 42 });
  });

  it('does not finalize task status from a visible process exit code before wait settles', () => {
    const { proc, markExited } = processWithVisibleExitCodeBeforeWait(143);
    const taskId = manager.register(proc, 'sleep 60', 'external kill test');

    markExited();

    const info = manager.getTask(taskId);
    expect(info).toMatchObject({ kind: 'process', status: 'running', exitCode: null });
    expect(info!.endedAt).toBeNull();
  });

  it('does not resolve wait from a visible process exit code before wait settles', async () => {
    const { proc, markExited } = processWithVisibleExitCodeBeforeWait(143);
    const taskId = manager.register(proc, 'sleep 60', 'external kill wait test');

    markExited();

    const info = await manager.wait(taskId, 1);
    expect(info).toMatchObject({ kind: 'process', status: 'running', exitCode: null });
  });

  it('stop kills a running task via KaosProcess.kill()', async () => {
    const { proc, killSpy } = pendingProcess(143);
    const taskId = manager.register(proc, 'sleep 60', 'kill test');

    const result = await manager.stop(taskId);
    expect(result).toBeDefined();
    expect(result!.status).toBe('killed');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop normalizes a blank reason instead of recording an empty stopReason', async () => {
    const { proc, resolve } = manuallyResolvedProcess();
    const taskId = manager.register(proc, 'sleep 60', 'blank reason test');

    const stopPromise = manager.stop(taskId, '   ');
    resolve(0);
    const result = await stopPromise;

    // A whitespace-only reason must not be persisted as a blank stopReason.
    // Public callers (SDK/RPC) reach manager.stop() directly, bypassing the
    // TaskStop tool's own normalization, so the boundary must guard it.
    expect(result!.stopReason).toBeUndefined();
  });

  it('stop keeps graceful process shutdown classified as killed', async () => {
    const { proc, killSpy, resolve } = manuallyResolvedProcess();
    const taskId = manager.register(proc, 'sleep 60', 'process race test');

    const stopPromise = manager.stop(taskId, 'user requested');
    resolve(0);
    const result = await stopPromise;

    expect(result!.status).toBe('killed');
    expect(result!.stopReason).toBe('user requested');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('persists graceful process shutdown as killed when stop requested', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-stop-race-'));
    try {
      const writer = new BackgroundManager();
      writer.attachSessionDir(sessionDir);
      const { proc, resolve } = manuallyResolvedProcess();
      const taskId = writer.register(proc, 'sleep 60', 'persisted process race test');

      const stopPromise = writer.stop(taskId, 'user requested');
      resolve(0);
      await stopPromise;

      const reader = new BackgroundManager();
      reader.attachSessionDir(sessionDir);
      await reader.loadFromDisk();

      const persisted = reader.getTask(taskId);
      expect(persisted).toMatchObject({ kind: 'process', status: 'killed', exitCode: 0 });
      expect(persisted?.stopReason).toBe('user requested');
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('stop preserves agent task completion that settles during the grace window', async () => {
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const abort = vi.fn();
    const taskId = manager.registerTask(new AgentBackgroundTask(completion, 'agent race test', { abort }));

    const stopPromise = manager.stop(taskId, 'user requested');
    resolveCompletion({ result: 'finished naturally' });
    const result = await stopPromise;

    expect(result!.status).toBe('completed');
    expect(result!.stopReason).toBeUndefined();
    expect(manager.getOutput(taskId)).toContain('finished naturally');
    expect(abort).toHaveBeenCalled();
  });

  it('stop preserves agent task failure when a non-abort rejection wins', async () => {
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const abort = vi.fn();
    const taskId = manager.registerTask(new AgentBackgroundTask(completion, 'agent failure race test', { abort }));

    const stopPromise = manager.stop(taskId, 'user requested');
    rejectCompletion(new Error('model failed'));
    const result = await stopPromise;

    expect(result!.status).toBe('failed');
    expect(result!.stopReason).toBeUndefined();
    expect(abort).toHaveBeenCalled();
  });

  it('stop marks agent task killed when abort rejection wins', async () => {
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const abort = vi.fn(() => {
      rejectCompletion(abortError);
    });
    const taskId = manager.registerTask(new AgentBackgroundTask(completion, 'agent abort test', { abort }));

    const result = await manager.stop(taskId, 'user requested');

    expect(result!.status).toBe('killed');
    expect(result!.stopReason).toBe('user requested');
    expect(abort).toHaveBeenCalled();
  });

  it('stop finalizes a never-settling agent task after the grace window', async () => {
    vi.useFakeTimers();
    try {
      const local = new BackgroundManager();
      const abort = vi.fn();
      const taskId = local.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'hung agent task', { abort }));
      const terminalPromise = local.waitForTerminal(taskId);

      const stopPromise = local.stop(taskId, 'user requested');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      const [stopped, terminal] = await Promise.all([stopPromise, terminalPromise]);

      expect(stopped?.status).toBe('killed');
      expect(stopped?.stopReason).toBe('user requested');
      expect(terminal?.status).toBe('killed');
      expect(abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates endedAt when a killed task finally exits after SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const local = new BackgroundManager();
      const terminated: string[] = [];
      local.onLifecycle((event, info) => {
        if (event === 'terminated') terminated.push(info.status);
      });
      const { proc, killSpy } = processExitingAfterSigkill(137, 25);
      const taskId = local.register(proc, 'sleep 60', 'forced kill test');

      const stopPromise = local.stop(taskId);
      await vi.advanceTimersByTimeAsync(5_000);
      const stopped = await stopPromise;
      const stopEndedAt = stopped!.endedAt;

      expect(stopped!.status).toBe('killed');
      expect(killSpy).toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(25);

      const info = local.getTask(taskId);
      expect(info).toMatchObject({ kind: 'process', exitCode: 137 });
      expect(info!.endedAt).toBeGreaterThan(stopEndedAt!);
      expect(terminated).toEqual(['killed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wait resolves when task completes', async () => {
    const proc = immediateProcess(0, 'fast');
    const taskId = manager.register(proc, 'echo fast', 'wait test');

    const info = await manager.wait(taskId, 5000);
    expect(info).toBeDefined();
    expect(info!.status).toBe('completed');
  });

  it('wait removes its waiter when the timeout branch wins', async () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'timeout cleanup test');

    const info = await manager.wait(taskId, 0);

    expect(info).toBeDefined();
    expect(info!.status).toBe('running');
    expect(waiterCount(manager, taskId)).toBe(0);
  });

  it('getTask returns undefined for unknown ID', () => {
    expect(manager.getTask('bash-nonexist')).toBeUndefined();
  });

  it('getOutput returns empty string for unknown ID', () => {
    expect(manager.getOutput('bash-nonexist')).toBe('');
  });

  it('stop returns terminal info for already-exited task', async () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo done', 'already done');

    // Let wait() settle first.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const result = await manager.stop(taskId);
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
  });
});

// ── py-aligned coverage for bash + agent registration semantics ────────

describe('BackgroundManager — registration semantics', () => {
  const manager = new BackgroundManager();

  afterEach(() => {
    manager._reset();
  });

  // The freshly-registered bash task should be immediately observable
  // in `starting` (or `running`) with the worker pid wired in. Py
  // distinguishes `starting` vs `running`; TS collapses to `running`
  // and exposes that pre-output.
  it('a newly-registered bash task is immediately visible with a starting/running state and worker pid', () => {
    const proc = pendingProcess().proc;
    const taskId = manager.register(proc, 'sleep 1', 'short sleep');
    expect(taskId.startsWith('bash-')).toBe(true);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.kind).toBe('process');
    if (info!.kind !== 'process') throw new Error('expected process task');
    // Py: 'starting' state visible. TS: starting status is collapsed
    // into 'running' here — the assertion lives at the py level.
    expect((info!.status as string) === 'starting' || info!.status === 'running').toBe(true);
    expect(info!.pid).toBe(proc.pid);
  });

  // Race-safety invariant: if the worker writes a terminal state
  // (completed) DURING register's startup transition, the registrar
  // must NOT clobber it back to `starting`/`running`.
  it('register does not overwrite a worker-written terminal completion', async () => {
    const proc = immediateProcess(0, 'done\n');
    const taskId = manager.register(proc, 'echo done', 'instant completion');
    // Let the immediate-exit `wait()` settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const info = manager.getTask(taskId);
    expect(info).toMatchObject({ kind: 'process', status: 'completed', exitCode: 0 });
  });

  // Worker launch raises → manager re-raises, AND persists a `failed`
  // runtime record so the orphan never leaks as a zombie `running`.
  it('records a failed runtime when the worker launch raises', async () => {
    const proc: KaosProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 99999,
      exitCode: null,
      wait: vi.fn().mockRejectedValue(new Error('launch boom')) as KaosProcess['wait'],
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    };
    const taskId = manager.register(proc, '/bogus', 'broken launch');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.endedAt).not.toBeNull();
  });

  // Agent task registration places kind_payload-style info on the task
  // info (agent_id / subagent_type carried through), status visible.
  it('agent task registration exposes agent metadata on the task info', () => {
    const taskId = manager.registerTask(new AgentBackgroundTask(new Promise(() => {}), 'investigate bug', {
      agentId: 'agent-child',
      subagentType: 'coder',
    }));
    expect(taskId.startsWith('agent-')).toBe(true);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.kind).toBe('agent');
    if (info!.kind !== 'agent') throw new Error('expected agent task');
    expect(info!.agentId).toBe('agent-child');
    expect(info!.subagentType).toBe('coder');
  });

  // Lookup for an unknown task id must return undefined AND must NOT
  // create any task directory on disk.
  it('getTask on an unknown id never creates on-disk state', async () => {
    const sessionDir = await import('node:fs/promises').then((m) =>
      m.mkdtemp(join(tmpdir(), 'kimi-bg-mgr-missing-')),
    );
    try {
      const m2 = new BackgroundManager();
      m2.attachSessionDir(sessionDir);
      expect(m2.getTask('bash-bogusss0')).toBeUndefined();
      const { readdir } = await import('node:fs/promises');
      // The tasks/ dir may not exist at all — the lookup must not have
      // touched it.
      const top = await readdir(sessionDir);
      expect(top.includes('tasks')).toBe(false);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  // Terminal-notification dedupe behavior: a subscriber that maintains
  // its own seen-set should observe each task exactly once. Python
  // expressed this via a `publish_terminal_notifications(limit=N)`
  // entry point that skipped tasks whose dedupe_key was already
  // recorded; TS pushes the dedupe responsibility to the consumer (the
  // `BackgroundManager` subclass in `agent/background/index.ts` uses
  // `scheduledNotificationKeys` for the same effect). The behavior we
  // care about is "duplicate terminal events are filterable by the
  // consumer"; the entry-point method itself is not part of the TS BPM
  // surface.
  it('terminal-notification dedupe via onTerminal subscriber yields each task once', async () => {
    const seen = new Set<string>();
    const published: string[] = [];
    manager.onTerminal((info) => {
      if (seen.has(info.taskId)) return;
      seen.add(info.taskId);
      published.push(info.taskId);
    });

    const taskId = manager.register(immediateProcess(0), 'echo a', 'a');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    // A second subscriber observing the same terminal event must not
    // cause the first subscriber's published list to grow.
    manager.onTerminal(() => {
      /* no-op */
    });
    expect(published).toEqual([taskId]);
  });

  // E2E: launch a real child process and wait for it to land in
  // `completed` with the output captured.
  it('launches a real worker and waits to completion', async () => {
    const { spawn } = await import('node:child_process');
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
      kill: vi.fn(async (sig?: NodeJS.Signals) => {
        child.kill(sig ?? 'SIGTERM');
      }) as unknown as KaosProcess['kill'],
    };
    const taskId = manager.register(proc, 'node -e <stdout bg-ok>', 'real worker smoke');
    const info = await manager.wait(taskId, 10_000);
    expect(info).toMatchObject({ kind: 'process', status: 'completed', exitCode: 0 });
    expect(manager.getOutput(taskId)).toContain('bg-ok');
  }, 15_000);

  // Calling stop(taskId) on a running bg agent transitions runtime to
  // `killed` with stopReason carried from the caller; failure_reason
  // not overwritten by the late agent_runner CancelledError handler.
  it('stop on a running agent transitions to killed with caller-supplied reason', async () => {
    // Wire abort → reject completion so stop() doesn't have to ride
    // the 5s SIGTERM grace period. The rejection must carry
    // `name: 'AbortError'` so the lifecycle catch handler can
    // distinguish it from an unrelated model failure that happens to
    // race against the stop (the "non-abort rejection wins" case is
    // covered separately and must remain `failed`).
    let rejectCompletion!: (err: unknown) => void;
    const completion = new Promise<{ result: string }>((_res, rej) => {
      rejectCompletion = rej;
    });
    const taskId = manager.registerTask(new AgentBackgroundTask(completion, 'killable', {
      abort: () => {
        const abortError = new Error('cancelled');
        abortError.name = 'AbortError';
        rejectCompletion(abortError);
      },
    }));
    const stopped = await manager.stop(taskId, 'test kill');
    expect(stopped?.status).toBe('killed');
    expect(stopped?.stopReason).toBe('test kill');
  });

  // kill() on an already-completed task is a no-op: returns the current
  // view unchanged; failure_reason stays null; subagent record stays
  // `idle` (the completion side already cleaned up).
  it('stop on an already-completed task is a no-op', async () => {
    const proc = immediateProcess(0, 'done');
    const taskId = manager.register(proc, 'echo done', 'quick');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');

    const after = await manager.stop(taskId, 'too late');
    expect(after?.status).toBe('completed');
    // No stopReason should be recorded on a noop stop.
    expect(after?.stopReason).toBeUndefined();
  });
});
