/**
 * BashTool tests for the v2 shellTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/bash.test.ts`) and adapted
 * to the v2 constructor `(runner, kaos, background, options)`. Self-contained:
 * builds minimal fake `ISessionProcessRunner` / `IProcess`, `IKaos`, and
 * `IAgentTaskService` inline so the tool can be exercised without the
 * composition root. The fake `IAgentTaskService` drives the real
 * `ProcessTask` so stream observation, timeout and user-interrupt
 * semantics match production.
 *
 * Deviations from v1:
 *   - v1's `execWithEnv(args, env)` is now `runner.exec(args, { env })`, so
 *     spawn-call assertions read `options.env` from the second argument.
 */

import { PassThrough, Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskStatus,
  type ForegroundTaskReleaseReason,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import type { AgentTaskSettlement } from '#/agent/task/types';
import { userCancellationReason } from '#/_base/utils/abort';
import type { IConfigService } from '#/app/config/config';
import { ProcessTask } from '#/os/backends/node-local/tools/process-task';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { type ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import { type BashInput, BashInputSchema, BashTool } from '#/os/backends/node-local/tools/bash';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const posixEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

const windowsBashEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
  pathClass: 'win32',
  homeDir: 'C:\\Users\\test',
  ready: Promise.resolve(),
};


function processWithOutput(
  options: {
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly exitCode?: number | null;
    readonly wait?: () => Promise<number>;
    readonly kill?: (signal?: NodeJS.Signals) => Promise<void>;
  } = {},
): IProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout]);
  const stderr = Readable.from(options.stderr === undefined ? [] : [options.stderr]);
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 123,
    exitCode,
    wait: vi.fn(options.wait ?? (async () => exitCode)),
    kill: vi.fn(options.kill ?? (async () => {})),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function processWithInterleavedOutput(
  events: ReadonlyArray<{
    readonly stream: 'stdout' | 'stderr';
    readonly text: string;
    readonly delayMs: number;
  }>,
  exitCode = 0,
): IProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lastDelay = Math.max(...events.map((event) => event.delayMs), 0);
  const waitPromise = new Promise<number>((resolve) => {
    for (const event of events) {
      setTimeout(() => {
        const target = event.stream === 'stdout' ? stdout : stderr;
        target.write(event.text);
      }, event.delayMs);
    }
    setTimeout(() => {
      stdout.end();
      stderr.end();
      resolve(exitCode);
    }, lastDelay + 1);
  });

  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 124,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function pendingProcess(): {
  readonly proc: IProcess;
  readonly finish: (exitCode?: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveWait: (exitCode: number) => void = () => {};
  let currentExitCode: number | null = null;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (exitCode = 0): void => {
    if (currentExitCode !== null) return;
    currentExitCode = exitCode;
    stdout.end();
    stderr.end();
    resolveWait(exitCode);
  };
  return {
    proc: {
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 125,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: vi.fn(async () => waitPromise),
      kill: vi.fn(async () => {
        finish(143);
      }) as IProcess['kill'],
      dispose: vi.fn(async () => {}),
    },
    finish,
  };
}

function processWithVisibleExitBeforeWait(exitCode = 0): {
  proc: IProcess;
  finishWait: () => void;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: IProcess = {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 125,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };

  return {
    proc,
    finishWait: () => {
      resolveWait(exitCode);
    },
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

function processThatNeverExits(): IProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 126,
    exitCode: null,
    wait: vi.fn(async () => new Promise<number>(() => {})),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function processWithStreamError(options: {
  readonly stdoutError?: Error;
  readonly stderrError?: Error;
  readonly exitCode?: number;
} = {}): IProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const waitPromise = new Promise<number>((resolve) => {
    setTimeout(() => {
      if (options.stdoutError !== undefined) {
        stdout.emit('error', options.stdoutError);
      } else {
        stdout.end();
      }
      if (options.stderrError !== undefined) {
        stderr.emit('error', options.stderrError);
      } else {
        stderr.end();
      }
      resolve(exitCode);
    }, 1);
  });
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 128,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

function processWithOpenStreamsThatExitOnKill(): IProcess {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 127,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {
      currentExitCode = 143;
      resolveWait(143);
    }),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}


function createTestEnv(env: IHostEnvironment = posixEnv): IHostEnvironment {
  return env;
}

function createTestCtx(cwd = '/workspace'): ISessionContext {
  return makeSessionContext({
    sessionId: 's',
    workspaceId: 'w',
    sessionDir: cwd,
    sessionScope: 'sessions/w/s',
    cwd,
  });
}


function createTestRunner(proc: IProcess | ReturnType<typeof vi.fn>) {
  const exec = typeof proc === 'function' ? proc : vi.fn().mockResolvedValue(proc);
  const runner = { exec } as unknown as ISessionProcessRunner;
  return { runner, exec };
}


const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);
const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

interface ManagedEntry {
  readonly taskId: string;
  readonly task: AgentTask;
  readonly startedDetached: boolean;
  readonly options: RegisterAgentTaskOptions;
  readonly outputChunks: string[];
  readonly abortController: AbortController;
  readonly startedAt: number;
  readonly waiters: Array<() => void>;
  status: AgentTaskStatus;
  stopReason?: string;
  endedAt: number | null;
  foregroundRelease?: ForegroundRelease;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  lifecyclePromise: Promise<void>;
  signalCleanup?: () => void;
}

function createRelease(): ForegroundRelease {
  let resolve!: (reason: ForegroundTaskReleaseReason) => void;
  const promise = new Promise<ForegroundTaskReleaseReason>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFakeTaskService(options: { maxRunningTasks?: number } = {}): {
  readonly service: IAgentTaskService;
  readonly tasks: Map<string, ManagedEntry>;
  readonly persisted: Set<string>;
} {
  const tasks = new Map<string, ManagedEntry>();
  const persisted = new Set<string>();
  let counter = 0;

  const nextId = (prefix: string): string => {
    counter += 1;
    const suffix = counter.toString(TASK_ID_ALPHABET.length).padStart(8, '0');
    return `${prefix}-${suffix}`;
  };

  const entryToInfo = (entry: ManagedEntry): AgentTaskInfo => {
    return entry.task.toInfo({
      taskId: entry.taskId,
      description: entry.task.description,
      status: entry.status,
      detached: entry.foregroundRelease === undefined,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
    });
  };

  const settleTask = (entry: ManagedEntry, settlement: AgentTaskSettlement): boolean => {
    if (isTerminal(entry.status)) return false;
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    entry.signalCleanup?.();
    entry.signalCleanup = undefined;
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    entry.foregroundRelease?.resolve('terminal');
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) waiter();
    return true;
  };

  const stopEntry = async (
    entry: ManagedEntry,
    reason: string | undefined,
  ): Promise<AgentTaskInfo> => {
    if (isTerminal(entry.status)) return entryToInfo(entry);
    entry.stopReason = reason;
    entry.abortController.abort(reason);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (isTerminal(entry.status)) return entryToInfo(entry);
    if (!graceful) {
      try {
        await entry.task.forceStop?.();
      } catch {
      }
    }
    if (isTerminal(entry.status)) return entryToInfo(entry);
    settleTask(entry, { status: 'killed', stopReason: reason });
    return entryToInfo(entry);
  };

  const detachEntry = (entry: ManagedEntry, viaTimeout: boolean): AgentTaskInfo => {
    if (isTerminal(entry.status)) return entryToInfo(entry);
    const release = entry.foregroundRelease;
    if (release === undefined) return entryToInfo(entry);
    entry.foregroundRelease = undefined;
    entry.signalCleanup?.();
    entry.signalCleanup = undefined;
    const detachTimeoutMs = entry.options.detachTimeoutMs;
    if (detachTimeoutMs !== undefined) {
      if (entry.timeoutHandle !== undefined) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = undefined;
      }
      if (detachTimeoutMs > 0) {
        entry.timeoutHandle = setTimeout(() => {
          entry.abortController.abort('Timed out');
          void settleTask(entry, { status: 'timed_out' });
        }, detachTimeoutMs);
        entry.timeoutHandle.unref?.();
      }
    }
    try {
      entry.task.onDetach?.();
    } catch {
    }
    release.resolve(viaTimeout ? 'timeout_detached' : 'detached');
    return entryToInfo(entry);
  };

  const activeDetachedCount = (): number => {
    let count = 0;
    for (const entry of tasks.values()) {
      if (entry.startedDetached && !isTerminal(entry.status)) count += 1;
    }
    return count;
  };

  const service: IAgentTaskService = {
    _serviceBrand: undefined,
    track(): never {
      throw new Error('fake IAgentTaskService.track is not implemented');
    },

    registerTask(task: AgentTask, registerOptions: RegisterAgentTaskOptions = {}): string {
      const detached = registerOptions.detached ?? true;
      if (detached && options.maxRunningTasks !== undefined) {
        if (activeDetachedCount() >= options.maxRunningTasks) {
          throw new Error('Too many background tasks are already running.');
        }
      }

      const taskId = nextId(task.idPrefix);
      const abortController = new AbortController();
      const entry: ManagedEntry = {
        taskId,
        task,
        startedDetached: detached,
        options: registerOptions,
        outputChunks: [],
        abortController,
        startedAt: Date.now(),
        waiters: [],
        status: 'running',
        endedAt: null,
        foregroundRelease: detached ? undefined : createRelease(),
        lifecyclePromise: Promise.resolve(),
      };
      tasks.set(taskId, entry);

      const timeoutMs = registerOptions.timeoutMs;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timeoutHandle = setTimeout(() => {
          if (
            registerOptions.autoBackgroundOnTimeout === true &&
            entry.foregroundRelease !== undefined
          ) {
            detachEntry(entry, true);
            return;
          }
          entry.abortController.abort('Timed out');
          void settleTask(entry, { status: 'timed_out' });
        }, timeoutMs);
        entry.timeoutHandle.unref?.();
      }

      entry.lifecyclePromise = Promise.resolve()
        .then(() =>
          task.start({
            signal: abortController.signal,
            appendOutput: (chunk: string) => {
              entry.outputChunks.push(chunk);
            },
            settle: async (settlement: AgentTaskSettlement) => settleTask(entry, settlement),
          }),
        )
        .catch((error: unknown) => {
          const status = abortController.signal.aborted ? 'killed' : 'failed';
          void settleTask(entry, {
            status,
            stopReason: status === 'failed' ? errorMessage(error) : undefined,
          });
        });

      if (!detached && registerOptions.signal !== undefined) {
        const signal = registerOptions.signal;
        const abortFromSignal = (): void => {
          if (entry.foregroundRelease === undefined) return;
          void stopEntry(entry, userCancellationReason().message);
        };
        if (signal.aborted) {
          abortFromSignal();
        } else {
          signal.addEventListener('abort', abortFromSignal, { once: true });
          entry.signalCleanup = () => {
            signal.removeEventListener('abort', abortFromSignal);
          };
        }
      }

      return taskId;
    },

    getTask(taskId: string): AgentTaskInfo | undefined {
      const entry = tasks.get(taskId);
      return entry === undefined ? undefined : entryToInfo(entry);
    },

    list(activeOnly = true): readonly AgentTaskInfo[] {
      const result: AgentTaskInfo[] = [];
      for (const entry of tasks.values()) {
        const info = entryToInfo(entry);
        if (activeOnly && isTerminal(info.status)) continue;
        result.push(info);
      }
      return result;
    },

    persistOutput(taskId: string): void {
      persisted.add(taskId);
    },

    async getOutputSnapshot(taskId: string): Promise<AgentTaskOutputSnapshot> {
      const entry = tasks.get(taskId);
      const preview = entry === undefined ? '' : entry.outputChunks.join('');
      const fullOutputAvailable = persisted.has(taskId);
      return {
        outputPath: fullOutputAvailable ? `/fake/tasks/${taskId}/output.log` : undefined,
        outputSizeBytes: preview.length,
        previewBytes: preview.length,
        truncated: false,
        fullOutputAvailable,
        preview,
      };
    },

    async readOutput(taskId: string, tail?: number): Promise<string> {
      const entry = tasks.get(taskId);
      const output = entry === undefined ? '' : entry.outputChunks.join('');
      if (tail === undefined) return output;
      return output.slice(-Math.max(0, Math.trunc(tail)));
    },

    async suppressTerminalNotification(): Promise<void> {
    },

    detach(taskId: string): AgentTaskInfo | undefined {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      return detachEntry(entry, false);
    },

    async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      return stopEntry(entry, reason);
    },

    async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
      return service.stop(taskId, userCancellationReason().message);
    },

    async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
      const results = await Promise.all(
        Array.from(tasks.keys()).map((taskId) => service.stop(taskId, reason)),
      );
      return results.filter((info): info is AgentTaskInfo => info !== undefined);
    },

    async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
      return service.stopAll(reason);
    },

    async wait(taskId: string, timeoutMs = 30_000): Promise<AgentTaskInfo | undefined> {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      if (isTerminal(entry.status)) return entryToInfo(entry);
      let waiter: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            waiter = resolve;
            entry.waiters.push(resolve);
          }),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (waiter !== undefined) {
          const index = entry.waiters.indexOf(waiter);
          if (index !== -1) entry.waiters.splice(index, 1);
        }
      }
      return entryToInfo(entry);
    },

    async waitForForegroundRelease(
      taskId: string,
    ): Promise<ForegroundTaskReleaseReason | undefined> {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      if (isTerminal(entry.status)) return 'terminal';
      const release = entry.foregroundRelease;
      if (release === undefined) return 'detached';
      return Promise.race([
        release.promise,
        entry.lifecyclePromise.then(() => 'terminal' as const),
      ]);
    },
  };

  return { service, tasks, persisted };
}


function context(
  args: BashInput,
  signal = new AbortController().signal,
  onForegroundTaskStart?: (taskId: string) => void,
) {
  return { turnId: 0, toolCallId: 'call_bash', args, signal, onForegroundTaskStart };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function executeTool(
  tool: BashTool,
  ctx: ReturnType<typeof context>,
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = ctx;
  const resolved = tool.resolveExecution(args);
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  return execution.execute(executionContext as ExecutableToolContext);
}

function stubToolPolicy(
  isToolActive: (name: string) => boolean = () => true,
): IAgentToolPolicyService {
  return {
    _serviceBrand: undefined,
    isToolActive,
  } as unknown as IAgentToolPolicyService;
}

function stubConfig(values: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (section: string) => values[section],
  } as unknown as IConfigService;
}

function bashTool(
  runner: ISessionProcessRunner,
  env: IHostEnvironment = createTestEnv(),
  ctx: ISessionContext = createTestCtx(),
  background: IAgentTaskService = createFakeTaskService().service,
  toolPolicy: IAgentToolPolicyService = stubToolPolicy(),
  config: IConfigService = stubConfig(),
): BashTool {
  return new BashTool(runner, env, ctx, background, toolPolicy, config);
}


describe('BashTool', () => {
  it('exposes current metadata and schema', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    expect(tool.name).toBe('Bash');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { command: { type: 'string' } },
    });
    expect(BashInputSchema.safeParse({ command: 'echo hello' }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 0 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300 }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 301 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300_000 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300_001 }).success).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 86_400,
      }).success,
    ).toBe(true);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 86_401,
      }).success,
    ).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 600_000,
      }).success,
    ).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        disable_timeout: true,
      }).success,
    ).toBe(true);
  });

  it('describes the cwd, command, run_in_background, description, and disable_timeout parameters', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);
    const properties = (tool.parameters as { properties: Record<string, { description?: string }> })
      .properties;

    for (const name of [
      'cwd',
      'command',
      'run_in_background',
      'description',
      'disable_timeout',
    ] as const) {
      const description = properties[name]?.description;
      expect(description, `${name} should have a non-empty description`).toBeTruthy();
      expect((description ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('exposes a default timeout in the JSON Schema', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);
    const properties = (tool.parameters as { properties: Record<string, { default?: number }> })
      .properties;

    expect(properties['timeout']?.default).toBe(60);
  });

  it('renders the available commands section and the /tasks hint', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    expect(tool.description).toContain('Commands available');
    expect(tool.description).toContain('/tasks');
  });

  it('runs through runner.exec, injects cwd, noninteractive env, and closes stdin', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const { runner, exec } = createTestRunner(proc);
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'printf ok', timeout: 60 }));

    expect(exec).toHaveBeenCalledTimes(1);
    const [argv, execOptions] = exec.mock.calls[0]!;
    expect(argv).toEqual(['/bin/bash', '-c', "cd '/workspace' && printf ok"]);
    expect(execOptions?.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
    });
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
    });
  });

  it('uses args.cwd when provided', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'sub\n' }));
    const tool = bashTool(runner);

    await executeTool(tool, context({ command: 'pwd', cwd: '/tmp/project', timeout: 60 }));

    expect(exec.mock.calls[0]?.[0]).toEqual(['/bin/bash', '-c', "cd '/tmp/project' && pwd"]);
  });

  it('uses the kaos cwd as the default working directory', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner, posixEnv, createTestCtx('/var/app'));

    await executeTool(tool, context({ command: 'pwd', timeout: 60 }));

    expect(exec.mock.calls[0]?.[0]).toEqual(['/bin/bash', '-c', "cd '/var/app' && pwd"]);
  });

  it('uses Git Bash semantics on Windows', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const { runner, exec } = createTestRunner(proc);
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'));

    const result = await executeTool(tool, context({ command: 'echo ok 2>nul', timeout: 60 }));

    expect(exec).toHaveBeenCalledTimes(1);
    const [argv, execOptions] = exec.mock.calls[0]!;
    expect(argv).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '-c',
      "cd '/c/Users/me/project' && echo ok 2>/dev/null",
    ]);
    expect(execOptions?.env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
    });
  });

  it('returns stderr and marks non-zero exit codes as tool errors', async () => {
    const { runner } = createTestRunner(processWithOutput({ stderr: 'boom\n', exitCode: 2 }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'exit 2', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('boom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns both stdout and stderr when a command succeeds', async () => {
    const { runner } = createTestRunner(processWithOutput({ stdout: 'out\n', stderr: 'warn\n' }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'mixed', timeout: 60 }));

    expect(result).toMatchObject({
      output: 'out\nwarn\n',
      isError: false,
    });
  });

  it('returns both stdout and stderr when a command fails', async () => {
    const { runner } = createTestRunner(
      processWithOutput({ stdout: 'partial\n', stderr: 'boom\n', exitCode: 2 }),
    );
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'mixed fail', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('partial\nboom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns the service failure reason when foreground process wait rejects', async () => {
    const { runner } = createTestRunner(
      processWithOutput({
        stdout: 'partial output\n',
        exitCode: null,
        wait: async () => {
          throw new Error('wait failed');
        },
      }),
    );
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'wait fails', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'wait failed',
    });
    expect(result.output).toContain('partial output\nwait failed');
    expect(result.output).not.toContain('exit code: null');
  });

  it('preserves foreground stdout and stderr arrival order', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithInterleavedOutput([
        { stream: 'stderr', text: 'err-first\n', delayMs: 0 },
        { stream: 'stdout', text: 'out-second\n', delayMs: 5 },
        { stream: 'stderr', text: 'err-third\n', delayMs: 10 },
      ]);
      const { runner } = createTestRunner(proc);
      const tool = bashTool(runner);

      const resultPromise = executeTool(tool, context({ command: 'mixed', timeout: 60 }));
      await vi.advanceTimersByTimeAsync(11);

      const result = await resultPromise;
      expect(result).toMatchObject({
        isError: false,
        output: 'err-first\nout-second\nerr-third\n',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('interprets small timeout values as seconds at runtime', async () => {
    vi.useFakeTimers();
    try {
      let resolveWait: (code: number) => void = () => {};
      const waitPromise = new Promise<number>((resolve) => {
        resolveWait = resolve;
      });
      const proc = processWithOutput({
        wait: async () => waitPromise,
        kill: async () => {
          resolveWait(143);
        },
      });
      const { runner } = createTestRunner(proc);
      const tool = bashTool(runner);

      const running = executeTool(tool, context({ command: 'sleep 3', timeout: 2 }));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(proc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const result = await running;

      expect(proc.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
      });
      expect(result.output).toContain('task_id: bash-');
      resolveWait(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a timed-out command with the timeout message when auto-background is disabled', async () => {
    vi.useFakeTimers();
    try {
      let resolveWait: (code: number) => void = () => {};
      const waitPromise = new Promise<number>((resolve) => {
        resolveWait = resolve;
      });
      const proc = processWithOutput({
        wait: async () => waitPromise,
        kill: async () => {
          resolveWait(143);
        },
      });
      const { runner } = createTestRunner(proc);
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        createFakeTaskService().service,
        stubToolPolicy(),
        stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);
      const result = await running;

      expect(result).toMatchObject({ isError: true, brief: 'Killed by timeout (1s)' });
      expect(result.output).toContain('Command killed by timeout (1s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports timeout instead of premature close when cleanup destroys open output streams', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithOpenStreamsThatExitOnKill();
      const { runner } = createTestRunner(proc);
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        createFakeTaskService().service,
        stubToolPolicy(),
        stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);
      const result = await running;

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toMatchObject({ isError: true, brief: 'Killed by timeout (1s)' });
      expect(result.output).toContain('Command killed by timeout (1s)');
      expect(result.output).not.toContain('Premature close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stream read error as a tool error even when the process exits with code 0', async () => {
    const proc = processWithStreamError({
      stdoutError: new Error('SSH channel read failed'),
      exitCode: 0,
    });
    const { runner } = createTestRunner(proc);
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'remote-cmd', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('SSH channel read failed');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'echo nope' }, controller.signal));

    expect(result).toEqual({ isError: true, output: 'Aborted before command started' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('kills the process and returns an abort result when aborted while running', async () => {
    let resolveWait: (code: number) => void = () => {};
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = processWithOutput({
      wait: async () => waitPromise,
      kill: async () => {
        resolveWait(143);
      },
    });
    const { runner } = createTestRunner(proc);
    const controller = new AbortController();
    const tool = bashTool(runner);

    const running = executeTool(tool, context({ command: 'sleep 10' }, controller.signal));
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    controller.abort();
    const result = await running;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Interrupted by user');
  });

  it('adds a truncation note when stdout exceeds the cap', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(result.output).toContain('[...truncated]');
    expect(result.output).toContain('Output is truncated');
  });

  it('marks the truncated output buffer with a "[...truncated]" sentinel at the cut point', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('[...truncated]');
  });

  it('truncates output with the sentinel even when the command fails', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'E');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge, exitCode: 1 }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'fail-and-flood', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('[...truncated]');
    expect(output).toContain('Output is truncated');
  });

  it('saves full foreground output when the inline result is truncated', async () => {
    const fullOutput = `${'short line\n'.repeat(6_000)}tail survives\n`;
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, persisted } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));
    const output = result.output as string;
    const taskId = /^task_id: (bash-[0-9a-z]{8})$/m.exec(output)?.[1];

    expect(output).toContain('[...truncated]');
    expect(output).toContain('[Full output saved]');
    expect(taskId).toBeTruthy();
    expect(persisted.has(taskId!)).toBe(true);
    expect(output).toContain(`output_path: /fake/tasks/${taskId}/output.log`);
    expect(output).toContain('Use Read with output_path');
    expect(output).toContain(`TaskOutput(task_id="${taskId}", block=false)`);
  });

  it('omits the TaskOutput hint from the saved-output reference when background tools are disabled', async () => {
    const fullOutput = 'short line\n'.repeat(6_000);
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service, stubToolPolicy(() => false));

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));
    const output = result.output as string;

    expect(output).toContain('[Full output saved]');
    expect(output).toContain('Use Read with output_path');
    expect(output).not.toContain('TaskOutput');
  });

  it('rejects empty-string commands at the schema layer', () => {
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
  });

  it('does not inject GIT_SSH_COMMAND into the spawn environment', async () => {
    const previous = process.env['GIT_SSH_COMMAND'];
    delete process.env['GIT_SSH_COMMAND'];
    try {
      const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'ok\n' }));
      const tool = bashTool(runner);

      await executeTool(tool, context({ command: 'true', timeout: 60 }));

      const env = exec.mock.calls[0]?.[1]?.env as Record<string, string>;
      expect(Object.prototype.hasOwnProperty.call(env, 'GIT_SSH_COMMAND')).toBe(false);
    } finally {
      if (previous !== undefined) process.env['GIT_SSH_COMMAND'] = previous;
    }
  });

  it('rewrites nul-redirect on Windows so the spawned argv has /dev/null', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'));

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const argv = exec.mock.calls[0]?.[0] as readonly string[];
    expect(argv[2]).toBe("cd '/c/Users/me/project' && ls 2>/dev/null");
  });

  it('passes nul-redirect through unchanged on Linux so the argv keeps the literal file target', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner);

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const argv = exec.mock.calls[0]?.[0] as readonly string[];
    expect(argv[2]).toBe("cd '/workspace' && ls 2>nul");
  });

  it('exposes a shell description that documents /bin/bash, TaskOutput/TaskStop, safety and efficiency sections, and background semantics', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    const description = tool.description;
    expect(description).toContain('`bash`');
    expect(description).toContain('TaskOutput');
    expect(description).toContain('TaskStop');
    expect(description).toContain('**Guidelines for safety and security:**');
    expect(description).toContain('**Guidelines for efficiency:**');
    expect(description).toContain('run_in_background=true');
    expect(description).toContain('automatically notified');
    expect(description).toContain('returning control to the user');
  });

  it('disables background execution when TaskList is inactive even if TaskOutput/TaskStop are active', async () => {
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy((name) => name !== 'TaskList'),
    );

    expect(tool.description).toContain('Background execution is disabled for this agent');

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Background execution is not available');
    expect(exec).not.toHaveBeenCalled();
  });

  it('describes timeout behavior according to the auto-background config', () => {
    const { runner } = createTestRunner(processWithOutput());
    const autoBg = bashTool(runner);
    expect(autoBg.description).toContain('moved to the background instead of being killed');

    const killOnTimeout = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
    );
    expect(killOnTimeout.description).not.toContain('moved to the background instead of being killed');
    expect(killOnTimeout.description).toContain('hits its timeout is killed');

    const legacyKillOnTimeout = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ background: { bashAutoBackgroundOnTimeout: false } }),
    );
    expect(legacyKillOnTimeout.description).toContain('hits its timeout is killed');

    const noBackground = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(() => false),
    );
    expect(noBackground.description).not.toContain('moved to the background instead of being killed');
    expect(noBackground.description).toContain('hits its timeout is killed');
  });
});

describe('BashTool background mode', () => {
  it('can detach a foreground command through the background service', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;
    await vi.waitFor(() => {
      expect((proc.stdout as PassThrough).listenerCount('data')).toBeGreaterThanOrEqual(1);
    });
    (proc.stdout as PassThrough).write('before detach\n');

    expect(task).toMatchObject({
      kind: 'process',
      detached: false,
      command: 'sleep 10',
    });

    service.detach(task.taskId);
    const result = await running;
    (proc.stdout as PassThrough).write('after detach\n');

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('before detach\n');
    expect(result.output).not.toContain('after detach\n');
    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput');
    expect((result as { brief?: string }).brief).toBe(`Backgrounded ${task.taskId}`);
    expect(service.getTask(task.taskId)).toMatchObject({ detached: true });
    await vi.waitFor(async () => {
      await expect(service.readOutput(task.taskId)).resolves.toContain('after detach\n');
    });

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('notifies when a foreground command registers its background task', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const started = vi.fn();

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }, undefined, started));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    expect(started).toHaveBeenCalledWith(task.taskId);

    finish();
    await running;
  });

  it('applies the background timeout when a foreground command is detached', async () => {
    vi.useFakeTimers();
    try {
      const { proc } = pendingProcess();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const running = executeTool(tool, context({ command: 'sleep 10', timeout: 1 }));
      await vi.waitFor(() => {
        expect(service.list(false)).toHaveLength(1);
      });
      const task = service.list(false)[0]!;

      service.detach(task.taskId);
      await running;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.getTask(task.taskId)?.status).toBe('running');

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(service.getTask(task.taskId)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a timed-out foreground command to the background instead of killing it', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finish } = pendingProcess();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const running = executeTool(tool, context({ command: 'sleep 30', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await running;

      expect(proc.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
        brief: expect.stringContaining('after timeout'),
      });
      const taskId = /^task_id: (\S+)/m.exec(result.output as string)?.[1];
      expect(taskId).toBeDefined();
      expect(service.getTask(taskId!)).toMatchObject({ status: 'running', detached: true });

      (proc.stdout as PassThrough).write('after timeout\n');
      finish(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(service.getTask(taskId!)).toMatchObject({ status: 'completed' });
      await expect(service.readOutput(taskId!)).resolves.toContain('after timeout\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recommend disabled task tools when a foreground command is detached', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service, stubToolPolicy(() => false));

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    service.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('You will be automatically notified when it completes');
    expect(result.output).toContain('do NOT wait or poll');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('keeps task metadata independent when noisy foreground output is capped before detach', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'yes noisy', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;
    await vi.waitFor(() => {
      expect((proc.stdout as PassThrough).listenerCount('data')).toBeGreaterThanOrEqual(1);
    });

    (proc.stdout as PassThrough).write(
      Array.from({ length: 6000 }, (_, index) => `noisy output line ${String(index)}\n`).join(''),
    );
    service.detach(task.taskId);
    const result = await running;

    expect(result).toMatchObject({ isError: false });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain(`task_id: ${task.taskId}`);
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('foreground_output:');
    expect(output).toContain('noisy output line 0');
    expect(output).toContain('[...truncated]');
    expect(output).toContain('Output is truncated to fit in the message.');
    expect(output.indexOf(`task_id: ${task.taskId}`)).toBeLessThan(
      output.indexOf('foreground_output:'),
    );

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('requires background tools to be enabled and description for background commands', async () => {
    const proc = processWithOutput();
    const { runner, exec } = createTestRunner(proc);
    const backgroundDisabled = bashTool(
      runner,
      createTestEnv(), createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(() => false),
    );

    const unavailable = await executeTool(
      backgroundDisabled,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );
    expect(unavailable).toMatchObject({ isError: true });
    expect(unavailable.output).toContain('Background execution is not available');
    expect(exec).not.toHaveBeenCalled();

    const { service } = createFakeTaskService();
    const withService = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const missingDescription = await executeTool(
      withService,
      context({ command: 'sleep 10', run_in_background: true }),
    );

    expect(missingDescription).toMatchObject({ isError: true });
    expect(missingDescription.output).toContain('description is required');
    expect(exec).not.toHaveBeenCalled();
  });

  it('registers background commands and returns a task id', async () => {
    const proc = processWithOutput();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'long running task' }),
    );

    expect(result.output).toMatch(/task_id: bash-[0-9a-z]{8}/);
    expect(result.output).toContain('automatic_notification: true');
    expect((result as { brief?: string }).brief).toMatch(/^Started bash-[0-9a-z]{8}$/);
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(result.output).not.toContain('block=false');
    expect(service.list(false)).toHaveLength(1);
  });

  it('kills a spawned background command when the task limit is reached', async () => {
    const { service } = createFakeTaskService({ maxRunningTasks: 1 });
    service.registerTask(new ProcessTask(processWithOutput(), 'sleep 10', 'existing task'));
    const rejectedProc = processWithOutput();
    const { runner, exec } = createTestRunner(rejectedProc);
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'second task' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(rejectedProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects one of two concurrent background commands when the task limit is reached', async () => {
    const { service } = createFakeTaskService({ maxRunningTasks: 1 });
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const first = executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'first task' }),
    );
    const second = executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'second task' }),
    );

    const results = await Promise.all([first, second]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(secondProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results).toContainEqual(expect.objectContaining({ isError: false }));
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('uses Git Bash semantics and rejects the concurrent command at the task limit', async () => {
    const { service } = createFakeTaskService({ maxRunningTasks: 1 });
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'), service);

    const first = executeTool(
      tool,
      context({
        command: 'echo ok 2>nul',
        run_in_background: true,
        description: 'first task',
      }),
    );
    const second = executeTool(
      tool,
      context({
        command: 'echo second',
        run_in_background: true,
        description: 'second task',
      }),
    );

    const results = await Promise.all([first, second]);

    expect(exec).toHaveBeenCalledTimes(2);
    const [argv, execOptions] = exec.mock.calls[0]!;
    expect(argv).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '-c',
      "cd '/c/Users/me/project' && echo ok 2>/dev/null",
    ]);
    expect(execOptions?.env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(secondProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results).toContainEqual(expect.objectContaining({ isError: false }));
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('timeout-stops a background task that has not settled even if process exit is visible', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finishWait, markExited } = processWithVisibleExitBeforeWait(0);
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
        context({
          command: 'sleep 10',
          run_in_background: true,
          description: 'exit before close',
          timeout: 1,
        }),
      );
      expect(typeof result.output).toBe('string');
      if (typeof result.output !== 'string') throw new Error('Expected string tool output.');
      const taskId = result.output.match(/task_id: (bash-[0-9a-z]{8})/)?.[1];
      expect(taskId).toBeDefined();

      markExited();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      finishWait();
      await vi.runAllTimersAsync();

      expect(service.getTask(taskId!)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout-stops a background task after the default 10 minute deadline', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
        context({
          command: 'sleep 999',
          run_in_background: true,
          description: 'default deadline',
        }),
      );
      expect(result).toMatchObject({ isError: false });

      await vi.advanceTimersByTimeAsync(600_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not timeout-stop a background task when disable_timeout is true', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
        context({
          command: 'sleep 999',
          run_in_background: true,
          description: 'no deadline',
          disable_timeout: true,
        }),
      );
      expect(result).toMatchObject({ isError: false });

      await vi.advanceTimersByTimeAsync(600_000 + 10_000);

      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports background task startup with task_id, status, automatic_notification, and a human-shell hint', async () => {
    const proc = processWithOutput();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true, description: 'sleep task' }),
    );

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('task_id:');
    expect(output).toContain('status: running');
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(output).not.toContain('block=false');
    expect(output).toContain('human_shell_hint:');
    expect(output).toContain('/tasks');
  });

  it('rejects background command without description (description-required guard)', async () => {
    const { service } = createFakeTaskService();
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('description is required');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('BashTool prompt / runtime consistency', () => {
  it('reports unavailable background using only tools the prompt documents', async () => {
    const { runner } = createTestRunner(processWithOutput());

    const enabledTool = bashTool(runner);
    const promptToolNames = new Set(
      [...enabledTool.description.matchAll(/`(Task[A-Za-z]+)`/g)].map((match) => match[1]),
    );

    const tool = bashTool(runner, createTestEnv(), createTestCtx(), createFakeTaskService().service, stubToolPolicy(() => false));
    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const errorToolNames = [...(result.output as string).matchAll(/\b(Task[A-Za-z]+)\b/g)].map(
      (match) => match[1],
    );

    for (const name of errorToolNames) {
      expect(promptToolNames).toContain(name);
    }
    expect(errorToolNames.length).toBeGreaterThan(0);
  });

  it('does not claim failure exit codes appear in a system tag', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    expect(tool.description).not.toMatch(/exit code will be provided in a system tag/);
  });
});
